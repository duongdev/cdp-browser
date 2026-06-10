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

// Register (or refresh) a workspace seen as its own tab. Returns a new registry object;
// never mutates the input. Ignores entries with no resolvable teamId.
function upsertWorkspace(registry, { teamId, url, name }, now) {
  if (!teamId) return registry
  return {
    ...registry,
    [teamId]: { teamId, url, name: name || "", lastSeen: now },
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
// created within the cooldown. `createdAt` maps teamId → last create timestamp. Pure.
function planParkedTabs(registry, live, createdAt, now) {
  const plans = []
  for (const teamId of Object.keys(registry)) {
    if (live.has(teamId)) continue
    const last = createdAt[teamId]
    if (last && now - last < CREATE_COOLDOWN_MS) continue
    plans.push({ teamId, url: registry[teamId].url })
  }
  return plans
}

module.exports = { upsertWorkspace, liveTeamIds, planParkedTabs, teamIdOf, CREATE_COOLDOWN_MS }
