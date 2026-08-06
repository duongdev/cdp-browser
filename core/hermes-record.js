// Writes a Hermes-proxied turn back into chat-server's own session store (t179).
//
// The turn runs on the Hermes agent, so chat-server's turn route — which persists the
// exchange, names the session and compacts inline — never executes. Measured on preview:
// two turns through the proxy left 0 rows and title=null, so a panel reload showed an
// empty thread while Hermes still held the history. The panel loads its thread from
// chat-server, so unrecorded means gone from the user's point of view.
//
// Everything here is best-effort by design. A failed write must degrade the record, never
// the answer the user is waiting on — the alternative is losing a turn that already ran
// and already cost tokens.
//
// Tested by hermes-record.test.ts.

// Same ceiling the recording route enforces; checked here too so an oversized answer is
// truncated into history rather than rejected whole and lost.
const MAX_PARTS_CHARS = 256_000

function endpoint(bffUrl, sessionId, suffix = "") {
  return `${String(bffUrl).replace(/\/+$/, "")}/api/chat/assistant/sessions/${encodeURIComponent(sessionId)}${suffix}`
}

/**
 * Persist one message. Resolves to true when chat-server accepted it.
 *
 * `maintain` triggers title generation + compaction on chat-server. Set it on the message
 * that CLOSES an exchange (the assistant reply), never on the opening user write — firing
 * it early would name the session from a half-exchange.
 */
async function recordMessage({ bffUrl, sessionId, message, maintain = false, fetchImpl }, onError) {
  const doFetch = fetchImpl || globalThis.fetch
  try {
    const res = await doFetch(endpoint(bffUrl, sessionId, "/messages"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, maintain }),
    })
    if (!res.ok) {
      onError?.(`record ${message.role} -> ${res.status}`)
      return false
    }
    return true
  } catch (e) {
    onError?.(`record ${message.role} failed: ${e?.message || e}`)
    return false
  }
}

/**
 * Build the user-message row for a turn.
 *
 * Reuses the id the AI SDK already generated for this message when there is one. That id is
 * what `appendMessage` dedups on, so a retry of the same turn overwrites its own row instead
 * of stacking duplicates in the thread.
 */
function userMessageFrom(body, text, makeId) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  let existing = null
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      existing = messages[i]
      break
    }
  }
  return {
    id: existing?.id || makeId(),
    role: "user",
    parts: [{ type: "text", text }],
    metadata: existing?.metadata,
  }
}

/**
 * Build the assistant-message row from the text the translator accumulated.
 *
 * A turn stopped mid-flight still gets recorded, flagged `interrupted`. That is the whole
 * point of option B: a user who navigates away and comes back must see what happened, and
 * an unrecorded partial answer is indistinguishable from a turn that never ran.
 */
function assistantMessageFrom(text, { interrupted = false, model = "" } = {}, makeId) {
  const body = String(text || "")
  const clipped = body.length > MAX_PARTS_CHARS ? body.slice(0, MAX_PARTS_CHARS) : body
  const metadata = {}
  if (interrupted) metadata.interrupted = true
  if (model) metadata.model = model
  return {
    id: `a-${makeId()}`,
    role: "assistant",
    // An interrupted turn with no text at all still needs a row, or the thread reloads
    // showing a question with no reply and no explanation.
    parts: [{ type: "text", text: clipped || (interrupted ? "_(stopped)_" : "") }],
    metadata: Object.keys(metadata).length ? metadata : undefined,
  }
}

/**
 * Build the system-message row that marks a model switch (Dustin's ask: not just a log line,
 * a visible row in the thread).
 *
 * Written only after the gateway confirms the lock, so the thread cannot claim a switch that
 * did not take — the exact failure mode this whole change set is fixing.
 */
function modelChangeMessage(from, to, makeId) {
  return {
    id: `sys-${makeId()}`,
    role: "system",
    parts: [{ type: "text", text: `Model changed to ${to}` }],
    // The renderer keys off metadata.kind, not the text — a marker row must never be
    // mistaken for something the assistant said.
    metadata: { kind: "model-change", from: from || null, to },
  }
}

module.exports = {
  recordMessage,
  userMessageFrom,
  assistantMessageFrom,
  modelChangeMessage,
  MAX_PARTS_CHARS,
}
