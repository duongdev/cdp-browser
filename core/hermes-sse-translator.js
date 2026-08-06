// Translates Hermes gateway SSE into AI SDK v7 UIMessageChunk frames, so the
// assistant panel's existing `useChat` transport can consume a Hermes agent turn
// without knowing Hermes exists (PSN-133).
//
// This is NOT a pass-through proxy, for two measured reasons:
//
//   1. Hermes puts the event type ONLY in the SSE `event:` line, and useChat
//      parses with EventSourceParserStream, which reads `data:` and ignores
//      `event:`. Piping the bytes through loses every type. We re-encode the
//      type into the data payload.
//   2. AI SDK requires start/start-step wrappers and text-start/text-end
//      bracketing that Hermes has no equivalent for, plus a stable id per text
//      block. That state has to live somewhere — here.
//
// The wire contract this implements was captured from a live gateway, not read
// off the source: docs/memories/hermes-sse-contract.md. Two observed quirks
// drive real code below:
//
//   - `tool.progress` can arrive BEFORE `tool.started` for the same tool.
//   - `tool.completed` arrives with `args` and `preview` null, and Hermes has
//     NO per-call tool id — correlation is (tool_name + message_id) only. We
//     mint our own ids and key them on that pair. Two parallel calls to the
//     same tool in one message are therefore indistinguishable upstream; the
//     last-started wins. Acceptable because the panel renders tools serially,
//     but it is a real ceiling, not an oversight.
//
// Pure and transport-free (a string in, an array of `data: ...` lines out) so it
// unit-tests against the recorded contract with no socket. CommonJS to match the
// shared-core convention (ADR-0008) — web/server.mjs imports it directly.
// Tested by hermes-sse-translator.test.ts.

const { createLineSplitter } = require("./line-splitter.js")

/** Hermes emits a `_thinking` pseudo-tool for reasoning traces. */
const THINKING_TOOL = "_thinking"

function createHermesTranslator() {
  const splitter = createLineSplitter()

  // `stream: true` keeps a partial multi-byte character buffered across pushes.
  // fetch's ReadableStream yields Uint8Array and chunk boundaries land wherever TCP
  // puts them — including mid-codepoint — so decoding each chunk independently would
  // corrupt any non-ASCII text (Vietnamese diacritics, emoji).
  const decoder = new TextDecoder("utf-8")

  // Frame assembly: SSE sends `event:` and `data:` on separate lines.
  let pendingEvent = null

  // Turn state.
  const openTools = new Map() // `${message_id}\n${tool_name}` -> toolCallId
  const openText = new Set() // message_ids with an unclosed text-start
  const openReasoning = new Set() // message_ids with an unclosed reasoning-start
  let toolSeq = 0

  // Captured from `run.started` and never cleared: the proxy needs it during
  // teardown to interrupt a run the client walked away from.
  let runId = null

  // The assistant's answer, accumulated as it streams (t179). The proxy writes this back
  // into chat-server after the turn, because on the Hermes path chat-server never sees the
  // reply and the panel loads its thread from chat-server — unrecorded reads as lost.
  // Accumulated here rather than re-parsed by the caller: this is the only place the frames
  // are already decoded and assembled.
  let answer = ""
  let sawDelta = false
  let interrupted = false

  function toolKey(data) {
    return `${data.message_id || ""}\n${data.tool_name || ""}`
  }

  function chunk(obj) {
    return `data: ${JSON.stringify(obj)}`
  }

  function translate(event, data) {
    switch (event) {
      case "run.started":
        if (data.run_id) runId = data.run_id
        return [chunk({ type: "start" }), chunk({ type: "start-step" })]

      case "message.started": {
        const id = data.message_id
        if (!id || openText.has(id)) return []
        openText.add(id)
        return [chunk({ type: "text-start", id })]
      }

      case "assistant.delta": {
        const id = data.message_id
        if (!id || !data.delta) return []
        answer += data.delta
        sawDelta = true
        // Defensive: a delta without a preceding message.started would produce
        // an unbracketed text block, which AI SDK drops silently.
        const out = []
        if (!openText.has(id)) {
          openText.add(id)
          out.push(chunk({ type: "text-start", id }))
        }
        out.push(chunk({ type: "text-delta", id, delta: data.delta }))
        return out
      }

      case "assistant.completed": {
        const id = data.message_id
        const out = []
        if (data.interrupted) interrupted = true
        // Non-streaming turns arrive as one `assistant.completed` with the whole answer and
        // no deltas at all, so the recorded text has to come from `content` in that case.
        // Only when nothing streamed: otherwise `content` repeats what the deltas already
        // built, and the thread would reload showing the answer twice. An interrupted turn's
        // `content` is the interrupt notice, not a reply, so it is never recorded as one.
        if (!sawDelta && !data.interrupted && typeof data.content === "string") {
          answer += data.content
        }
        // A stopped turn carries the interrupt notice in `content` and is NOT a
        // model reply — surfacing it as text would render "Operation
        // interrupted: ..." as if the assistant said it. Close the block and
        // signal abort instead. (Requires the gateway patch that reports
        // interrupted honestly; see docs/memories/hermes-sse-contract.md.)
        if (id && openReasoning.has(id)) {
          openReasoning.delete(id)
          out.push(chunk({ type: "reasoning-end", id }))
        }
        if (id && openText.has(id)) {
          openText.delete(id)
          out.push(chunk({ type: "text-end", id }))
        }
        if (data.interrupted) out.push(chunk({ type: "abort" }))
        return out
      }

      case "tool.started": {
        const key = toolKey(data)
        const toolCallId = `hermes_tool_${++toolSeq}`
        openTools.set(key, toolCallId)
        return [
          chunk({ type: "tool-input-start", toolCallId, toolName: data.tool_name }),
          chunk({
            type: "tool-input-available",
            toolCallId,
            toolName: data.tool_name,
            input: data.args ?? {},
          }),
        ]
      }

      case "tool.completed": {
        const key = toolKey(data)
        const toolCallId = openTools.get(key)
        // No matching start (dropped frame, or a completed we never saw open):
        // emitting an output for an unknown id corrupts the AI SDK message.
        if (!toolCallId) return []
        openTools.delete(key)
        return [
          chunk({
            type: "tool-output-available",
            toolCallId,
            output: data.preview ?? "",
          }),
        ]
      }

      case "tool.failed": {
        const key = toolKey(data)
        const toolCallId = openTools.get(key)
        if (!toolCallId) return []
        openTools.delete(key)
        return [
          chunk({
            type: "tool-output-error",
            toolCallId,
            errorText: String(data.error || data.preview || "tool failed"),
          }),
        ]
      }

      case "tool.progress": {
        // Only the reasoning pseudo-tool has a UI representation; real tools'
        // progress has no AI SDK equivalent and is dropped rather than faked.
        if (data.tool_name !== THINKING_TOOL) return []
        const id = data.message_id
        if (!id || !data.delta) return []
        const out = []
        if (!openReasoning.has(id)) {
          openReasoning.add(id)
          out.push(chunk({ type: "reasoning-start", id }))
        }
        out.push(chunk({ type: "reasoning-delta", id, delta: data.delta }))
        return out
      }

      case "run.completed":
        return [chunk({ type: "finish-step" }), chunk({ type: "finish" })]

      case "error":
        return [chunk({ type: "error", errorText: String(data.message || "stream error") })]

      case "done":
        return ["data: [DONE]"]

      // Unknown / future Hermes events are ignored: the gateway adds event
      // types independently of this client, and a hard failure on an unknown
      // name would break the panel on every gateway upgrade.
      default:
        return []
    }
  }

  return {
    /** The gateway run id, once `run.started` has been seen. Null before that. */
    runId() {
      return runId
    },

    /** The assistant text seen so far, and whether the turn was interrupted (t179). Read
     *  after the stream ends — or after the client leaves mid-turn, where a partial answer
     *  is exactly what must be recorded so the thread is not silently empty. */
    answer() {
      return { text: answer, interrupted }
    },

    /**
     * Feed a raw SSE chunk from Hermes; returns the AI SDK `data: ...` lines it
     * completed. Accepts a string or the Uint8Array a fetch body stream yields.
     * Handles frames split across TCP boundaries.
     */
    push(raw) {
      // Uint8Array.toString() yields "101,118,101,..." (char codes), which parses as
      // nothing and silently produces an empty stream — a clean 200 with no body and
      // no error. Decode bytes properly instead of stringifying them.
      const text = typeof raw === "string" ? raw : decoder.decode(raw, { stream: true })
      const out = []
      for (const line of splitter.push(text)) {
        if (line.startsWith("event:")) {
          pendingEvent = line.slice(6).trim()
          continue
        }
        if (!line.startsWith("data:")) continue

        const body = line.slice(5).trim()
        const event = pendingEvent
        pendingEvent = null
        if (!event) continue

        let data
        try {
          data = JSON.parse(body)
        } catch {
          // A malformed frame must not kill a long-lived stream — the rest of
          // the turn is still usable.
          continue
        }
        out.push(...translate(event, data))
      }
      return out
    },
  }
}

module.exports = { createHermesTranslator }
