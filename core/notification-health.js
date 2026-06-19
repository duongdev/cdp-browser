// Pure capture-health aggregation (t074, ADR-0011). Makes Slack capture failure visible:
// composes the per-workspace cred records (from the notification center) with the server's
// sweep metadata into a health report, and gates the one-time "reconnect Slack" alert on a
// healthy→degraded transition. No I/O — the server supplies the data and fires the alert.
//
// Grid grouping (t092): creds sharing an `enterprise_id` (an org pseudo-team + its member
// workspaces) collapse to ONE row keyed by `groupId = enterprise_id || teamId`, so an
// Enterprise Grid shows a single row instead of N near-identical ones. A standalone team
// (no enterprise_id) is its own group, byte-unchanged.

const { groupId } = require("./slack-creds")

// The health status of one workspace:
//   "unsupported" — the web API is permanently blocked (Enterprise Grid team_is_restricted);
//                   the sweep can't cover it (the hijack is the only capture).
//   "degraded"    — creds are stale (a 401), so the sweep can't run until re-extraction.
//   "healthy"     — fresh creds, sweep operating.
function statusFor(cred) {
  if (cred.sweepUnsupported) return "unsupported"
  if (cred.fresh === false) return "degraded"
  return "healthy"
}

// The best status of a Grid group: healthy if ANY member sweeps via client.counts, else
// degraded if any has stale creds, else unsupported. A single client.counts member (the org
// pseudo-team) covers the whole org's shared channels, so the group is "capturing" even when
// a restricted member alone would read as unsupported.
const STATUS_RANK = { unsupported: 0, degraded: 1, healthy: 2 }
function bestStatus(statuses) {
  return statuses.reduce(
    (best, s) => (STATUS_RANK[s] > STATUS_RANK[best] ? s : best),
    "unsupported",
  )
}

// A friendlier merged-row label: prefer a member workspace's name (a cred carrying an
// enterprise_id — e.g. "FWD Group") over the org pseudo-team's verbose name; fall back to
// the first member's name, then the group id.
function groupLabel(members) {
  const rep = members.find((c) => c.enterpriseId) || members[0]
  return rep.name || rep.teamId || members[0].teamId
}

// Build the health report: one row per logical Slack workspace group. `sweepMeta` maps
// teamId → { seeded, lastSweepOk, lastEntryTs }. Creds sharing an enterprise_id merge into
// one row (Grid grouping, t092); a standalone team is its own group. Sweep metadata is
// aggregated across members (newest lastSweepOk / lastEntryTs; seeded if any member is).
// Returns rows sorted by status (problems first) then name.
function buildHealth(creds, sweepMeta) {
  const meta = sweepMeta || {}
  // Group creds by groupId, preserving first-seen order for stable representative selection.
  const groups = new Map()
  for (const c of creds || []) {
    const gid = groupId(c)
    if (!groups.has(gid)) groups.set(gid, [])
    groups.get(gid).push(c)
  }
  const rows = []
  for (const [gid, members] of groups) {
    const rep = members.find((c) => c.enterpriseId) || members[0]
    let seeded = false
    let lastSweepOk = null
    let lastEntryTs = null
    for (const c of members) {
      const m = meta[c.teamId] || {}
      if (m.seeded) seeded = true
      if (m.lastSweepOk && m.lastSweepOk > (lastSweepOk || 0)) lastSweepOk = m.lastSweepOk
      if (m.lastEntryTs && m.lastEntryTs > (lastEntryTs || 0)) lastEntryTs = m.lastEntryTs
    }
    rows.push({
      groupId: gid,
      // The representative concrete teamId — the deep-link/display anchor (a member, never gid
      // beyond a standalone team where they coincide).
      teamId: rep.teamId,
      teamIds: members.map((c) => c.teamId),
      enterpriseId: rep.enterpriseId || "",
      name: groupLabel(members),
      status: bestStatus(members.map(statusFor)),
      credsFresh: members.some((c) => c.fresh !== false),
      sweepUnsupported: members.every((c) => !!c.sweepUnsupported),
      selfResolved: members.some((c) => !!c.selfUserId),
      lastError: (members.find((c) => c.lastError) || {}).lastError || null,
      seeded,
      lastSweepOk,
      lastEntryTs,
    })
  }
  return rows.sort(
    (a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.name.localeCompare(b.name),
  )
}

// One-time alert gate: returns true only when a workspace crosses from a healthy state into
// a problem state (so the "reconnect Slack" alert fires once per degradation, not every poll).
// `prevStatus` is the last status seen (undefined on first sight).
function shouldAlert(prevStatus, newStatus) {
  if (newStatus === "healthy") return false
  // Fire when newly problematic: previously healthy/unknown, now degraded/unsupported.
  return prevStatus === undefined || prevStatus === "healthy"
}

module.exports = { buildHealth, statusFor, shouldAlert }
