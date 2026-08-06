// Which assistant requests belong to Hermes rather than chat-server (ADR-0028).
//
// Pulled out of web/server.mjs because it is the one place a mistake is silent and
// expensive: `/api/chat/assistant/:sessionId` is a SUBSET of the `/api/chat/*` BFF
// proxy path, so this runs first in the dispatch chain. Over-match and session
// listing breaks on a panel that otherwise looks healthy; under-match and every turn
// quietly falls back to the old chat-server loop with nothing in the logs.
//
// Tested by hermes-route.test.ts.

// The turn route: exactly one path segment after `/assistant`.
//
// The `[^/]+` here and the `id.includes("/")` check below are deliberately
// redundant — they reject the same inputs by different means (raw path vs decoded
// id), so no test can distinguish loosening one while the other stands. Kept as a
// pair anyway: the regex bounds the match, the decoded check catches `%2F`, and
// dropping either leaves the other doing load-bearing work alone.
const TURN_RE = /^\/api\/chat\/assistant\/([^/]+)$/

// Explicit Stop (t179). A turn now outlives its socket on purpose, so a closed stream can no
// longer mean "cancel" — the panel has to say so, and it says so here. `stop` cannot collide
// with a session id: it sits one segment DEEPER than the turn route.
const STOP_RE = /^\/api\/chat\/assistant\/([^/]+)\/stop$/

// Sibling routes that share `:sessionId`'s shape but are NOT sessions. chat-server
// registers these on the same prefix, so a bare `:sessionId` match would swallow them.
const RESERVED = new Set(["sessions", "models", "prefs"])

/** Shared id extraction for both routes: decode, reject reserved names, and reject anything
 *  that is structural in the upstream URL the id gets interpolated into. */
function sessionIdFrom(match) {
  let id
  try {
    id = decodeURIComponent(match)
  } catch {
    // Malformed percent-encoding: not a session id we can act on.
    return null
  }
  if (!id || RESERVED.has(id)) return null
  // The decoded id is interpolated into an upstream URL, so any character that is
  // structural THERE has to die here. `%2F` would address a different route; `%3F`
  // and `%23` are worse in a quieter way — `/api/sessions/a?x=1/chat/stream` parses
  // as path `/api/sessions/a` with the rest swallowed as a query string, so the turn
  // silently hits the wrong endpoint instead of failing.
  if (/[/\\?#]/.test(id)) return null
  return id
}

/**
 * Return the session id when this request is an assistant turn Hermes should serve,
 * else null (meaning: let the normal BFF proxy handle it).
 *
 * @param pathname  request path, no query string
 * @param method    HTTP method
 * @param enabled   whether a Hermes client is configured
 */
function hermesTurnSessionId(pathname, method, enabled) {
  if (!enabled) return null
  // Turns are POST-only. A GET on the same path is chat-server's message history,
  // and diverting it would empty the panel on every session open.
  if (method !== "POST") return null

  const m = TURN_RE.exec(pathname || "")
  if (!m) return null
  return sessionIdFrom(m[1])
}

/** Return the session id when this request is an explicit Stop for a Hermes turn, else null. */
function hermesStopSessionId(pathname, method, enabled) {
  if (!enabled) return null
  if (method !== "POST") return null

  const m = STOP_RE.exec(pathname || "")
  if (!m) return null
  return sessionIdFrom(m[1])
}

module.exports = { hermesTurnSessionId, hermesStopSessionId }
