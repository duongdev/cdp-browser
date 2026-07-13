// Pure Slack workspace registry + parked-tab planner (t070, ADR-0011). The registry is the
// set of Slack workspaces we've seen as their OWN tab — keyed by teamId, holding only
// non-secret metadata (`url`, `name`, `lastSeen`). It is persisted so the parked-tab keeper
// can recreate a workspace's tab after the user closes it or the browser restarts.
//
// Deliberate deviation from ADR-0011 decision 8 (which sketched persisting creds here):
// the `d` cookie is shared across all workspaces and `localConfig_v2` carries every team's
// token, so a single live Slack tab refreshes creds for ALL workspaces. The keeper just has
// to keep the tab alive; creds re-extract within one reconcile cycle. So NO secrets are
// persisted — the registry holds only workspace URLs/names. This is strictly safer than
// creds-at-rest and removes the cleanup burden. (Recorded for review.)

const { parseSlackContext } = require("./notifications")

// How long after creating a parked tab to suppress re-creating it — covers the window
// between `/json/new` and the tab appearing in the next `/json` target list.
const CREATE_COOLDOWN_MS = 30_000

// The teamId for a slack tab URL, or "" for non-client URLs (service worker, login, …).
function teamIdOf(url) {
  return parseSlackContext(url).teamId || ""
}

// A real Slack team id: `T…` standard or `E…` Enterprise Grid. The registry is keyed by
// this, so anything else is a phantom workspace — no creds, no sweep, but a parked tab the
// keeper reopens forever (t104).
const TEAM_ID_RE = /^[TE][A-Z0-9]+$/
function isTeamId(id) {
  return TEAM_ID_RE.test(id || "")
}

// The canonical parked-tab URL for a workspace. The registry must never persist an observed
// URL verbatim: a channel segment is noise, and a query string can carry a failure state
// (`?sso_failed=1`) that gets faithfully reopened into the same failure forever (t104).
function canonicalWorkspaceUrl(teamId) {
  return `https://app.slack.com/client/${teamId}`
}

// Register (or refresh) a workspace seen as its own tab. Returns a new registry object;
// never mutates the input. Ignores anything that isn't a real team id. `enterpriseId` (t092)
// is persisted so a cold start (no live creds yet) still knows a workspace's Grid org and
// can resolve its merged group bucket; "" for a standalone team (groupId falls to teamId).
function upsertWorkspace(registry, { teamId, name, enterpriseId }, now) {
  if (!isTeamId(teamId)) return registry
  return {
    ...registry,
    [teamId]: {
      teamId,
      url: canonicalWorkspaceUrl(teamId),
      name: name || "",
      enterpriseId: enterpriseId || "",
      lastSeen: now,
    },
  }
}

// Self-heal a persisted registry on load: drop phantom keys and rewrite any non-canonical
// URL. Without this, a registry already poisoned by the pre-t104 keeper keeps reopening its
// bad tab even after the code that created it is fixed. Pure.
function pruneRegistry(registry) {
  const clean = {}
  for (const [teamId, entry] of Object.entries(registry || {})) {
    if (!isTeamId(teamId)) continue
    clean[teamId] = { ...entry, teamId, url: canonicalWorkspaceUrl(teamId) }
  }
  return clean
}

// Is a Slack session visibly broken? A `*.slack.com` page target that resolves to no team id
// is Slack's own sign-in / SSO-failure landing page (the Grid host, `?sso_failed=1`, …), which
// is where a parked tab lands when the session has died. Opening more tabs cannot revive a
// dead session — each one just redirects to another landing page — so the keeper stands down
// until the user re-authenticates and capture health degrades honestly instead (t104). Pure.
function hasBrokenSlackSession(targets) {
  return (targets || []).some((t) => {
    if (t.type && t.type !== "page") return false
    return isSlackHost(t.url || "") && !teamIdOf(t.url || "")
  })
}

function isSlackHost(url) {
  try {
    return /(^|\.)slack\.com$/.test(new URL(url).hostname)
  } catch {
    return false
  }
}

// The set of teamIds that currently have a live Slack client tab among the targets.
function liveTeamIds(targets) {
  const ids = new Set()
  for (const t of targets || []) {
    const id = teamIdOf(t.url || "")
    if (id) ids.add(id)
  }
  return ids
}

// Which registered workspaces need a parked tab created: those with no live tab and not
// created within the cooldown. `createdAt` maps teamId → last create timestamp.
//
// `pinUrlByTeam` (t098) maps a pinned workspace's teamId → its pin URL. A pinned workspace
// is considered OWNED BY ITS PIN: the keeper never spawns an anonymous duplicate for it
// (closing its tab no longer resurrects a stray). Capture is unaffected because one live
// Slack tab refreshes creds for ALL workspaces and the sweep polls each over the web API
// regardless of which tab is live. So per-workspace tabs aren't needed — only one live tab
// is. When NO Slack tab is live and nothing else would open one, a single cred lifeline
// plan keeps one alive, preferring a pinned URL (so it adopts into the pin on next reload).
// Omitting `pinUrlByTeam` preserves the prior per-workspace behavior.
//
// `brokenSession` (t104) stands the keeper down entirely: with a dead Slack session every
// tab we open redirects straight to a sign-in landing page, so creating more only piles up
// invalid tabs the user has to keep closing. Pure.
function planParkedTabs(registry, live, createdAt, now, pinUrlByTeam = {}, brokenSession = false) {
  if (brokenSession) return []
  const offCooldown = (teamId) => {
    const last = createdAt[teamId]
    return !(last && now - last < CREATE_COOLDOWN_MS)
  }
  const plans = []
  for (const teamId of Object.keys(registry)) {
    if (live.has(teamId)) continue
    if (pinUrlByTeam[teamId]) continue // pin owns it — don't reopen
    if (!offCooldown(teamId)) continue
    plans.push({ teamId, url: registry[teamId].url })
  }
  // Cred lifeline: nothing live and nothing else planned → keep exactly one Slack tab alive
  // via a pinned workspace, so shared creds keep refreshing. Cooldown-gated; one is enough.
  if (live.size === 0 && plans.length === 0) {
    for (const teamId of Object.keys(pinUrlByTeam)) {
      if (!offCooldown(teamId)) continue
      plans.push({ teamId, url: pinUrlByTeam[teamId] })
      break
    }
  }
  return plans
}

module.exports = {
  upsertWorkspace,
  liveTeamIds,
  planParkedTabs,
  pruneRegistry,
  hasBrokenSlackSession,
  isTeamId,
  canonicalWorkspaceUrl,
  teamIdOf,
  CREATE_COOLDOWN_MS,
}
