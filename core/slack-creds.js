// Pure helpers for Slack credential extraction (t069, ADR-0011). The effectful part —
// running Runtime.evaluate / Network.getCookies over the side-channel — lives in
// notifications-sidechain.js; these are the I/O-free parsers + the fresh/stale state
// machine, so they're unit-testable without a CDP socket. Secrets never get logged in
// full (see `redact`).

// Parse the page's `localStorage.localConfig_v2` JSON into the per-workspace xoxc tokens.
// Slack stores every signed-in workspace under `teams[teamId] = { token, name, url,
// enterprise_id }`. Defensive: any malformed/missing input yields an empty result rather
// than throwing (the caller treats "no teams" as "nothing to extract yet").
function parseLocalConfig(raw) {
  let obj
  try {
    obj = JSON.parse(raw || "")
  } catch {
    return { lastActiveTeamId: null, teams: [] }
  }
  if (!obj || typeof obj !== "object" || !obj.teams || typeof obj.teams !== "object") {
    return { lastActiveTeamId: null, teams: [] }
  }
  const teams = []
  for (const teamId of Object.keys(obj.teams)) {
    const t = obj.teams[teamId]
    if (!t || !t.token) continue // a team with no token can't be swept
    teams.push({
      teamId,
      token: t.token,
      name: t.name || "",
      url: t.url || "",
      enterpriseId: t.enterprise_id || "",
    })
  }
  return { lastActiveTeamId: obj.lastActiveTeamId || null, teams }
}

// The `d` session cookie value from a CDP `Network.getCookies` result, or null.
function pickDCookie(cookies) {
  if (!Array.isArray(cookies)) return null
  const d = cookies.find((c) => c && c.name === "d")
  return d ? d.value : null
}

// Record the workspace's creds as fresh and clear any prior auth error.
function markFresh(record, creds) {
  return { ...(record || {}), ...creds, fresh: true, lastError: null }
}

// Flag a workspace's creds stale (e.g. after a 401), keeping the last creds so a later
// extraction can replace them. `reason` is recorded for the health surface (t074).
function markStale(record, reason) {
  return { ...(record || {}), fresh: false, lastError: reason || "stale" }
}

// Short, length-tagged preview of a secret for logs — never the full value.
function redact(secret) {
  if (!secret) return "(empty)"
  const s = String(secret)
  return `${s.slice(0, 6)}…(${s.length} chars)`
}

module.exports = { parseLocalConfig, pickDCookie, markFresh, markStale, redact }
