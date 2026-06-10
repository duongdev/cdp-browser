// Pure capture-health aggregation (t074, ADR-0011). Makes Slack capture failure visible:
// composes the per-workspace cred records (from the notification center) with the server's
// sweep metadata into a health report, and gates the one-time "reconnect Slack" alert on a
// healthy→degraded transition. No I/O — the server supplies the data and fires the alert.

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

// Build the health report: one row per known Slack workspace. `sweepMeta` maps teamId →
// { seeded, lastSweepOk, lastEntryTs }. Returns rows sorted by status (problems first) then name.
function buildHealth(creds, sweepMeta) {
  const meta = sweepMeta || {}
  const rows = (creds || []).map((c) => {
    const m = meta[c.teamId] || {}
    return {
      teamId: c.teamId,
      name: c.name || c.teamId,
      status: statusFor(c),
      credsFresh: c.fresh !== false,
      sweepUnsupported: !!c.sweepUnsupported,
      selfResolved: !!c.selfUserId,
      lastError: c.lastError || null,
      seeded: !!m.seeded,
      lastSweepOk: m.lastSweepOk || null,
      lastEntryTs: m.lastEntryTs || null,
    }
  })
  const rank = { unsupported: 0, degraded: 1, healthy: 2 }
  return rows.sort((a, b) => rank[a.status] - rank[b.status] || a.name.localeCompare(b.name))
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
