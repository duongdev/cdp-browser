import { describe, expect, it } from "vitest"
// @ts-expect-error -- shared CJS core, no types (ADR-0008)
import { createHermesTranslator } from "./hermes-sse-translator.js"

/**
 * Contract source: docs/memories/hermes-sse-contract.md — captured live from a
 * real Hermes gateway, not inferred from source.
 *
 * The translator turns Hermes's `event: <name>\ndata: {...}` stream into AI SDK
 * v7 UIMessageChunk frames (`data: {...}` with the type inside, `data: [DONE]`
 * to close). It must be stateful: AI SDK requires start/start-step wrappers and
 * text-start/text-end bracketing that Hermes has no equivalent for.
 */

/** Feed raw SSE text, collect the emitted AI SDK chunks (parsed, [DONE] as a marker). */
function run(translator: any, raw: string): any[] {
  const out: any[] = []
  for (const line of translator.push(raw)) {
    const body = line.startsWith("data: ") ? line.slice(6) : line
    out.push(body === "[DONE]" ? "[DONE]" : JSON.parse(body))
  }
  return out
}

function frame(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

const MSG = "msg_abc"
const RUN = "run_xyz"

describe("createHermesTranslator", () => {
  it("exposes the run id so the proxy can stop the run on abort", () => {
    // A dropped SSE socket does NOT cancel a Hermes turn (verified live), so the
    // proxy has to call /v1/runs/{id}/stop. `run.started` is the only frame that
    // carries the id — if the translator swallows it, Stop is unimplementable.
    const t = createHermesTranslator()
    expect(t.runId()).toBeNull()
    run(t, frame("run.started", { run_id: RUN, seq: 1 }))
    expect(t.runId()).toBe(RUN)
  })

  it("keeps the run id after the stream ends", () => {
    // Abort can land during teardown; the id must survive past `done`.
    const t = createHermesTranslator()
    run(t, frame("run.started", { run_id: RUN, seq: 1 }))
    run(t, frame("done", { run_id: RUN, seq: 2 }))
    expect(t.runId()).toBe(RUN)
  })

  it("decodes byte chunks, not just strings", () => {
    // A WHATWG ReadableStream (what fetch gives us) yields Uint8Array, and
    // Uint8Array.toString() returns "101,118,101,..." — comma-separated char codes,
    // not text. Feeding that in produces a silent empty stream: no frames, no error,
    // a clean 200 with nothing in it. Caught in end-to-end testing, not unit tests.
    const t = createHermesTranslator()
    const bytes = new TextEncoder().encode(frame("run.started", { run_id: RUN, seq: 1 }))
    const out = run(t, bytes as unknown as string)
    expect(out).toEqual([{ type: "start" }, { type: "start-step" }])
  })

  it("handles a multi-byte character split across two byte chunks", () => {
    // Streaming boundaries fall wherever TCP puts them, including mid-codepoint.
    // Decoding each chunk independently corrupts the character; the decoder has to
    // be stateful across pushes.
    const t = createHermesTranslator()
    run(t, frame("run.started", { run_id: RUN, seq: 1 }))
    run(t, frame("message.started", { message_id: MSG, seq: 2 }))

    const full = new TextEncoder().encode(
      frame("assistant.delta", { message_id: MSG, delta: "xin chào ✓", seq: 3 }),
    )
    const cut = 69 // verified to land strictly inside the `à` byte sequence
    const out = [
      ...run(t, full.slice(0, cut) as unknown as string),
      ...run(t, full.slice(cut) as unknown as string),
    ]
    const text = out
      .filter((f: any) => f.type === "text-delta")
      .map((f: any) => f.delta)
      .join("")
    expect(text).toBe("xin chào ✓")
  })

  it("keeps reasoning and text apart even though Hermes gives them one message_id", () => {
    // Hermes has no separate id for a thinking block, so both text-start and
    // reasoning-start carry the same message_id. Verified against the real AI SDK
    // parser (readUIMessageStream): it keys parts by block KIND as well as id, so
    // the two do not merge. Locked in here because switching to a derived id would
    // look harmless and this is what says it is unnecessary.
    const t = createHermesTranslator()
    const out = [
      ...run(t, frame("run.started", { run_id: RUN, seq: 1 })),
      ...run(t, frame("message.started", { message_id: MSG, seq: 2 })),
      ...run(
        t,
        frame("tool.progress", {
          message_id: MSG,
          tool_name: "_thinking",
          delta: "THINKING",
          seq: 3,
        }),
      ),
      ...run(t, frame("assistant.delta", { message_id: MSG, delta: "ANSWER", seq: 4 })),
    ]

    const reasoning = out.filter((f: any) => f.type === "reasoning-delta")
    const text = out.filter((f: any) => f.type === "text-delta")
    expect(reasoning.map((f: any) => f.delta)).toEqual(["THINKING"])
    expect(text.map((f: any) => f.delta)).toEqual(["ANSWER"])
    // Same id on both blocks is the contract, not an accident.
    expect(reasoning[0].id).toBe(text[0].id)
  })

  it("opens a run with start and start-step", () => {
    const t = createHermesTranslator()
    const out = run(t, frame("run.started", { run_id: RUN, seq: 1 }))
    expect(out).toEqual([{ type: "start" }, { type: "start-step" }])
  })

  it("brackets assistant text with text-start and text-end", () => {
    const t = createHermesTranslator()
    run(t, frame("run.started", { run_id: RUN, seq: 1 }))
    const started = run(t, frame("message.started", { message_id: MSG, seq: 2 }))
    expect(started).toEqual([{ type: "text-start", id: MSG }])

    const delta = run(t, frame("assistant.delta", { message_id: MSG, delta: "Hi", seq: 3 }))
    expect(delta).toEqual([{ type: "text-delta", id: MSG, delta: "Hi" }])

    const done = run(t, frame("assistant.completed", { message_id: MSG, content: "Hi", seq: 4 }))
    expect(done).toEqual([{ type: "text-end", id: MSG }])
  })

  it("closes a run with finish-step, finish and [DONE]", () => {
    const t = createHermesTranslator()
    run(t, frame("run.started", { run_id: RUN, seq: 1 }))
    const out = [
      ...run(t, frame("run.completed", { run_id: RUN, seq: 2 })),
      ...run(t, frame("done", { run_id: RUN, seq: 3 })),
    ]
    expect(out).toEqual([{ type: "finish-step" }, { type: "finish" }, "[DONE]"])
  })

  // --- tool calls ---------------------------------------------------------
  // Hermes has NO per-call tool id; the contract says correlate on
  // tool_name + message_id. The translator must therefore mint stable ids.
  it("mints a tool call id and emits input-start then input-available", () => {
    const t = createHermesTranslator()
    run(t, frame("run.started", { run_id: RUN, seq: 1 }))
    const out = run(
      t,
      frame("tool.started", {
        message_id: MSG,
        tool_name: "terminal",
        args: { command: "echo hi" },
        seq: 2,
      }),
    )
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ type: "tool-input-start", toolName: "terminal" })
    expect(out[1]).toMatchObject({
      type: "tool-input-available",
      toolName: "terminal",
      input: { command: "echo hi" },
    })
    expect(out[0].toolCallId).toBe(out[1].toolCallId)
    expect(out[0].toolCallId).toBeTruthy()
  })

  it("routes tool output back to the id minted at tool.started", () => {
    const t = createHermesTranslator()
    run(t, frame("run.started", { run_id: RUN, seq: 1 }))
    const started = run(
      t,
      frame("tool.started", {
        message_id: MSG,
        tool_name: "terminal",
        args: { command: "echo hi" },
        seq: 2,
      }),
    )
    // Contract: tool.completed arrives with args AND preview null.
    const done = run(
      t,
      frame("tool.completed", {
        message_id: MSG,
        tool_name: "terminal",
        args: null,
        preview: null,
        seq: 3,
      }),
    )
    expect(done).toHaveLength(1)
    expect(done[0]).toMatchObject({ type: "tool-output-available" })
    expect(done[0].toolCallId).toBe(started[0].toolCallId)
  })

  it("survives tool.progress arriving BEFORE tool.started", () => {
    // Observed in the live capture — progress preceded started for the same tool.
    const t = createHermesTranslator()
    run(t, frame("run.started", { run_id: RUN, seq: 1 }))
    expect(() =>
      run(
        t,
        frame("tool.progress", { message_id: MSG, tool_name: "terminal", delta: "...", seq: 2 }),
      ),
    ).not.toThrow()
    const started = run(
      t,
      frame("tool.started", {
        message_id: MSG,
        tool_name: "terminal",
        args: {},
        seq: 3,
      }),
    )
    expect(started[0].type).toBe("tool-input-start")
  })

  it("maps _thinking progress to reasoning chunks", () => {
    const t = createHermesTranslator()
    run(t, frame("run.started", { run_id: RUN, seq: 1 }))
    const first = run(
      t,
      frame("tool.progress", {
        message_id: MSG,
        tool_name: "_thinking",
        delta: "hmm",
        seq: 2,
      }),
    )
    expect(first).toEqual([
      { type: "reasoning-start", id: MSG },
      { type: "reasoning-delta", id: MSG, delta: "hmm" },
    ])
    // reasoning-start is emitted once, not per delta
    const second = run(
      t,
      frame("tool.progress", {
        message_id: MSG,
        tool_name: "_thinking",
        delta: " ok",
        seq: 3,
      }),
    )
    expect(second).toEqual([{ type: "reasoning-delta", id: MSG, delta: " ok" }])
  })

  // --- interruption -------------------------------------------------------
  it("does not present an interrupted turn as normal assistant text", () => {
    // Pre-patch, a stopped run reported interrupted:false and the interrupt
    // notice rode in `content` — a client would render it as a model reply.
    const t = createHermesTranslator()
    run(t, frame("run.started", { run_id: RUN, seq: 1 }))
    run(t, frame("message.started", { message_id: MSG, seq: 2 }))
    const out = run(
      t,
      frame("assistant.completed", {
        message_id: MSG,
        content: "Operation interrupted: waiting for model response (2.1s elapsed).",
        interrupted: true,
        partial: true,
        completed: false,
        seq: 3,
      }),
    )
    expect(out.some((c) => c.type === "abort")).toBe(true)
    expect(out.some((c) => c.type === "text-delta")).toBe(false)
  })

  // --- transport robustness ----------------------------------------------
  it("reassembles frames split across chunk boundaries", () => {
    const t = createHermesTranslator()
    const whole = frame("run.started", { run_id: RUN, seq: 1 })
    const cut = Math.floor(whole.length / 2)
    const out = [...run(t, whole.slice(0, cut)), ...run(t, whole.slice(cut))]
    expect(out).toEqual([{ type: "start" }, { type: "start-step" }])
  })

  it("emits an error chunk for a Hermes error event", () => {
    const t = createHermesTranslator()
    run(t, frame("run.started", { run_id: RUN, seq: 1 }))
    const out = run(t, frame("error", { message: "boom" }))
    expect(out).toEqual([{ type: "error", errorText: "boom" }])
  })

  it("ignores unknown events rather than throwing", () => {
    const t = createHermesTranslator()
    expect(() => run(t, frame("some.future.event", { seq: 1 }))).not.toThrow()
    expect(run(t, frame("another.new.one", { seq: 2 }))).toEqual([])
  })

  it("ignores malformed json without killing the stream", () => {
    const t = createHermesTranslator()
    expect(() => run(t, "event: run.started\ndata: {not json\n\n")).not.toThrow()
    const out = run(t, frame("run.started", { run_id: RUN, seq: 1 }))
    expect(out).toEqual([{ type: "start" }, { type: "start-step" }])
  })
})
