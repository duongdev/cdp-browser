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
// never mutates the input. Ignores entries with no resolvable teamId. `enterpriseId` (t092)
// is persisted so a cold start (no live creds yet) still knows a workspace's Grid org and
// can resolve its merged group bucket; "" for a standalone team (groupId falls to teamId).
function upsertWorkspace(registry, { teamId, url, name, enterpriseId }, now) {
  if (!teamId) return registry
  return {
    ...registry,
    [teamId]: { teamId, url, name: name || "", enterpriseId: enterpriseId || "", lastSeen: now },
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
// Omitting `pinUrlByTeam` preserves the prior per-workspace behavior. Pure.
function planParkedTabs(registry, live, createdAt, now, pinUrlByTeam = {}) {
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

module.exports = { upsertWorkspace, liveTeamIds, planParkedTabs, teamIdOf, CREATE_COOLDOWN_MS }
