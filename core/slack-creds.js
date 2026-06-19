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

// The logical workspace key for a cred (t092, ADR-0011 Grid grouping). In an Enterprise
// Grid, Slack registers the org itself as a pseudo-team (an `E…`-prefixed team with no
// `enterprise_id`) alongside its member workspaces (each carrying that `enterprise_id`),
// and the org token surfaces the same channels the member workspace does — so the sweep
// captures shared channels twice under different `teamId` prefixes. Grouping by
// `enterpriseId || teamId` collapses the org + its workspaces to ONE bucket: same
// message → same id → existing ingest dedup. A standalone team (no enterpriseId) keys by
// its own teamId, so behavior is unchanged for it.
function groupId(cred) {
  return (cred && (cred.enterpriseId || cred.teamId)) || ""
}

// Build the teamId → groupId map from the cred list — the renderer needs it to resolve a
// Slack Tab/Pin URL (which only carries a concrete teamId) to its merged group bucket.
function buildSlackGroups(creds) {
  const map = {}
  for (const c of creds || []) {
    if (!c || !c.teamId) continue
    map[c.teamId] = groupId(c)
  }
  return map
}

// Short, length-tagged preview of a secret for logs — never the full value.
function redact(secret) {
  if (!secret) return "(empty)"
  const s = String(secret)
  return `${s.slice(0, 6)}…(${s.length} chars)`
}

module.exports = {
  parseLocalConfig,
  pickDCookie,
  groupId,
  buildSlackGroups,
  markFresh,
  markStale,
  redact,
}
