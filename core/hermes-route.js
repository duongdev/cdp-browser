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

// Sibling routes that share `:sessionId`'s shape but are NOT sessions. chat-server
// registers these on the same prefix, so a bare `:sessionId` match would swallow them.
const RESERVED = new Set(["sessions", "models", "prefs"])

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

  let id
  try {
    id = decodeURIComponent(m[1])
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

module.exports = { hermesTurnSessionId }
