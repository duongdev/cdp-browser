// Slack web API client (t067) — the effectful, cred-injected reader the Slack content
// sweep (ADR-0011) calls. Server-side only (Node). It authenticates with an extracted
// `xoxc-…` token + `d` cookie (the same internal web API the official Slack client uses),
// is rate-limit aware (honors HTTP 429 `Retry-After`), and surfaces a 401 as a typed
// `{ error: "invalid_auth" }` result rather than throwing — so the caller can mark the
// workspace's creds stale (t069) instead of crashing the poll loop.
//
// Holds no creds of its own: token/cookie/baseUrl are injected per workspace. Pure-ish —
// the only effects are `fetch` and `sleep`, both injectable for tests.

const DEFAULT_BASE = "https://slack.com"
const MAX_RETRIES = 2 // one retry after a 429 / transient network error

const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms))

// deps = { token, cookie, baseUrl?, fetch?, sleep?, now? }
function createSlackApi(deps) {
  const token = deps.token
  const cookie = deps.cookie
  const baseUrl = (deps.baseUrl || DEFAULT_BASE).replace(/\/+$/, "")
  const doFetch = deps.fetch || globalThis.fetch
  const sleep = deps.sleep || sleepReal

  // One Slack web API POST. `extra` is a flat map of extra form fields. Returns the parsed
  // JSON body, or a typed `{ error }` for auth failures. Retries once on 429 (honoring
  // Retry-After) or a thrown network error. Never throws for an auth rejection.
  async function call(method, extra) {
    const url = `${baseUrl}/api/${method}`
    let lastErr = null
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const body = new URLSearchParams()
      body.set("token", token)
      if (extra) for (const k of Object.keys(extra)) body.set(k, String(extra[k]))
      let resp
      try {
        resp = await doFetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            // The xoxc token is only valid paired with its `d` session cookie.
            Cookie: `d=${cookie}`,
          },
          body,
        })
      } catch (e) {
        // Network error — retry once, then surface as a typed transient error.
        lastErr = e
        if (attempt < MAX_RETRIES - 1) {
          await sleep(500)
          continue
        }
        return { error: "network_error", detail: String(e && e.message ? e.message : e) }
      }
      // HTTP-level auth rejection.
      if (resp.status === 401 || resp.status === 403) return { error: "invalid_auth" }
      // Rate limited — wait Retry-After (seconds) and retry.
      if (resp.status === 429) {
        const ra = Number(resp.headers.get("retry-after")) || 1
        if (attempt < MAX_RETRIES - 1) {
          await sleep(ra * 1000)
          continue
        }
        return { error: "rate_limited" }
      }
      // A wrong base URL / SSO wall returns an HTML page, not JSON — don't let resp.json()
      // throw into the sweep loop; treat a non-JSON body as a typed error.
      let json
      try {
        json = await resp.json()
      } catch {
        return { error: "bad_response" }
      }
      // Slack signals auth failure in-body even with HTTP 200.
      if (json && json.ok === false && json.error === "invalid_auth")
        return { error: "invalid_auth" }
      return json
    }
    return { error: "network_error", detail: String(lastErr) }
  }

  return {
    // Per-conversation unread/mention/thread counts + last_read watermarks. The sweep's
    // primary signal — it tells which channels/DMs changed without fetching every message.
    clientCounts: () => call("client.counts"),
    // Legacy counts endpoint — the fallback when client.counts is `team_is_restricted` on an
    // Enterprise Grid child (t075). No last_read/latest, but carries unread/mention counts +
    // per-channel is_muted, enough to drive the sweep in degraded mode.
    usersCounts: () =>
      call("users.counts", { include_file_channels: "true", only_relevant_ims: "false" }),
    // Messages in a conversation newer than `oldest` (a Slack ts). `inclusive:false` so the
    // already-seen watermark message isn't re-emitted.
    conversationsHistory: (channel, opts) =>
      call("conversations.history", {
        channel,
        oldest: (opts && opts.oldest) || "0",
        inclusive: "false",
        limit: (opts && opts.limit) || 50,
      }),
    // A user's display identity, for rendering `<@U…>` → @name (t073).
    usersInfo: (user) => call("users.info", { user }),
    // A conversation's metadata — `channel.name` for the "{sender} in #{channel}" title (t073).
    conversationsInfo: (channel) => call("conversations.info", { channel }),
    // The workspace's notification prefs — `muted_channels` (comma-separated channel ids)
    // is read by the sweep to honor Slack's own muted-channel state (t068).
    usersPrefsGet: () => call("users.prefs.get"),
    // The viewer's own user id — needed for channel @-mention parity (t068's isMention).
    authTest: () => call("auth.test"),
  }
}

module.exports = { createSlackApi, DEFAULT_BASE }
