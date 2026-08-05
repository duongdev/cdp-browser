// Talks to the Hermes gateway's session-chat API on behalf of the assistant panel
// (PSN-133). Pairs with hermes-sse-translator.js: this fetches the Hermes SSE
// stream, the translator reshapes it into AI SDK frames.
//
// Lives server-side only. The gateway API key must never reach the browser — a
// key leaked to a tab is a shell on the host user's machine, because the Hermes
// terminal tool runs unsandboxed. That constraint is the whole reason this is a
// BFF proxy rather than a direct browser-to-gateway call.
//
// Two shape mismatches this bridges, both measured against a live gateway:
//
//   1. `useChat` posts the ENTIRE message array every turn; Hermes reads a single
//      `message` string and keeps its own history server-side. Sending the array
//      would either be ignored (Hermes only reads `message`/`input`) or, done
//      naively, replay old turns. We extract just the newest user text.
//   2. Session ids: Hermes accepts a client-chosen id on create (verified: 201 for
//      a uuid-shaped id, 409 on a repeat, 404 for an unknown one). So the panel's
//      own session id is reused directly and NO id-mapping store is needed.
//
// `fetchImpl` is injected so the whole thing unit-tests with no socket.
// Tested by hermes-agent-client.test.ts.

/**
 * Pull the newest user text out of an AI SDK request body.
 * Exported because the empty-turn guard is a real failure mode worth testing
 * directly: a blank message makes the agent answer the previous turn again.
 */
function extractUserText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : null
  if (messages) {
    // Last USER message, not last message — an assistant turn can be the tail
    // when the client retries, and feeding that back makes the model reply to
    // its own output.
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m?.role !== "user") continue
      const parts = Array.isArray(m.parts) ? m.parts : []
      const text = parts
        .filter((p) => p?.type === "text" && typeof p.text === "string")
        .map((p) => p.text)
        .join("\n")
        .trim()
      if (text) return text
    }
    return ""
  }
  if (typeof body?.message === "string") return body.message.trim()
  if (typeof body?.input === "string") return body.input.trim()
  return ""
}

function createHermesClient({ baseUrl, apiKey, fetchImpl }) {
  // Fail at construction, not per-request: a missing key otherwise surfaces as a
  // generic 401 in the panel, which reads like a gateway outage rather than a
  // deploy that forgot an env var.
  if (!baseUrl) throw new Error("hermes client: base url is required")
  if (!apiKey) throw new Error("hermes client: api key is required")

  const root = String(baseUrl).replace(/\/+$/, "")
  const doFetch = fetchImpl || globalThis.fetch
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  }

  async function errorFrom(res, what) {
    let detail = ""
    try {
      const j = await res.json()
      detail = j?.error?.message || j?.error || ""
    } catch {
      // non-JSON body: the status alone is the signal
    }
    return new Error(`hermes ${what} failed: ${res.status}${detail ? ` ${detail}` : ""}`)
  }

  return {
    /**
     * Make sure the Hermes session exists, reusing the panel's own session id.
     * Idempotent: 409 means a previous turn already created it.
     */
    async ensureSession(sessionId) {
      const res = await doFetch(`${root}/api/sessions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ id: sessionId, source: "api_server" }),
      })
      // Create-and-tolerate-409 rather than GET-then-create: the pre-flight GET
      // would add a round-trip to every single turn to answer a question we only
      // care about once per session.
      if (res.ok || res.status === 409) return
      throw await errorFrom(res, "session create")
    },

    /**
     * Run one turn. Returns the raw Hermes SSE body stream — the caller pipes it
     * through the translator.
     */
    async streamTurn({ sessionId, body, systemMessage, signal }) {
      const message = extractUserText(body)
      // Guard before the session create, so a malformed request can't even leave
      // an empty session behind.
      if (!message) throw new Error("hermes turn: empty user message")

      await this.ensureSession(sessionId)

      const payload = { message }
      // Only set when present: an empty system_message would replace the agent's
      // configured prompt with nothing.
      if (systemMessage) payload.system_message = systemMessage

      const res = await doFetch(`${root}/api/sessions/${sessionId}/chat/stream`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal,
      })
      if (!res.ok) throw await errorFrom(res, "turn")
      return res.body
    },

    /**
     * What model this session is currently pinned to, as the gateway sees it. Empty string when
     * the session does not exist yet.
     *
     * The gateway PERSISTS the lock, so this is the authoritative previous value. Asking is what
     * keeps a proxy restart from writing a "Model changed to X" row into a thread where nothing
     * changed: an in-process cache alone reports every session as unlocked after a restart.
     *
     * Never throws — an unreadable session just means "no opinion", and the caller re-locks,
     * which the gateway accepts idempotently.
     */
    async sessionModel(sessionId) {
      try {
        const res = await doFetch(`${root}/api/sessions/${sessionId}`, { headers })
        if (!res.ok) return ""
        const body = await res.json()
        const model = body?.session?.model ?? body?.model
        return typeof model === "string" ? model : ""
      } catch {
        return ""
      }
    },

    /**
     * Pin a session to a model. Returns true when the gateway confirms the lock.
     *
     * A lock rather than a per-request `model` field because Hermes precedence is
     * lock > session override > session row > per-request: once a session carries any
     * lock, a per-request model is silently ignored (measured — a turn sent with
     * `{model: glm/glm-4.7}` still ran the locked `glm/glm-5.1`). Forwarding per-request
     * would have looked correct on a fresh session and quietly stopped working after the
     * first switch, which is the bug this fixes, one layer deeper.
     *
     * Never throws: a failed lock means the turn runs on the previous model, which the
     * caller reports honestly instead of failing the whole turn.
     */
    async lockModel(sessionId, model) {
      if (!model) return false
      try {
        const res = await doFetch(`${root}/api/sessions/${sessionId}/model`, {
          method: "POST",
          headers,
          body: JSON.stringify({ model }),
        })
        return res.ok
      } catch {
        return false
      }
    },

    /**
     * Interrupt a run. Best-effort and never throws.
     *
     * Note this is NOT called when the client merely disconnects (t179): a turn that
     * survives the tab is what lets the user come back to a finished answer. It is called
     * only for an explicit Stop, which the panel signals out-of-band.
     *
     * The `run_id` comes from the `run.started` frame — it is the only place it
     * appears, so the proxy has to sniff the stream to learn it.
     */
    async stopRun(runId) {
      if (!runId) return
      try {
        await doFetch(`${root}/v1/runs/${runId}/stop`, {
          method: "POST",
          headers,
          body: "{}",
        })
      } catch {
        // Called from an abort/teardown path: a failed stop must not replace the
        // real reason the turn ended, and there is no caller left to handle it.
      }
    },
  }
}

module.exports = { createHermesClient, extractUserText }
