// Unread accounting — one pure pass over the notification list that yields the
// per-group, per-Tab, and per-Pin unread badge counts.
//
// Notifications are attributed by *group*, so every Tab and Pin of the same app
// (all Teams, all Outlook, all of one Slack workspace) shares one count whether or
// not it captured the toast, and a dormant Pin still badges by its saved URL. The
// notification center stamps each entry's `groupKey` (an adapter's URL-derived key,
// else an explicit one, else the targetUrl origin); byGroup keys on it. A Tab/Pin
// resolves to its bucket via `groupKeyForUrl(url)` — the SAME derivation, so a Slack
// tab (all workspaces share the app.slack.com origin) resolves to its per-workspace
// `slack:{teamId}` key instead of the shared origin, keeping workspace counts distinct.
//
// Pure: no React, no window, no DOM. Effects (building `linkedTabByPin`, wiring
// the result into the sidebar/bell) live in app.tsx.

/** The notification fields the aggregator reads. */
export interface UnreadNotification {
  read: boolean
  targetUrl?: string
  /** Stamped by the notification center: an adapter-derived key (e.g. `slack:{teamId}`),
   *  an explicit capture-script key, or the targetUrl origin fallback. */
  groupKey?: string
}

/** The Tab fields the aggregator reads. */
export interface UnreadTab {
  id: string
  url: string
}

/** The Pin fields the aggregator reads. */
export interface UnreadPin {
  id: string
  url: string
}

export interface UnreadResult {
  /** key = groupKeyForUrl-style bucket → unread count */
  byGroup: Record<string, number>
  /** tab.id → unread count */
  byTab: Record<string, number>
  /** pin.id → unread count */
  byPin: Record<string, number>
}

function originOf(url: string | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/** teamId → groupId, for Enterprise Grid merging (t092). A Grid org pseudo-team and its
 *  member workspaces share one `groupId` (`enterprise_id || teamId`); the map collapses a
 *  Slack Tab/Pin URL — which only carries the concrete teamId — to its merged bucket. Empty
 *  for standalone teams (the URL teamId is already the bucket). */
export type TeamGroupMap = Record<string, string>

// Slack runs every workspace under one origin (app.slack.com), so resolving a Slack
// tab/pin by origin would merge all workspaces into one badge. Key it by team id instead
// — matching the `slack:{teamId}` group key the notification center stamps server-side
// (mirrors core/notifications.js `slackGroupKey`; one tab per workspace, so the URL is
// authoritative). With an Enterprise Grid `teamGroupMap`, the extracted teamId maps to its
// merged `groupId` (`map[teamId] || teamId`), so an org tab and its member workspace bucket
// together; no map entry → today's `slack:{teamId}`. `T…` standard / `E…` Grid, legacy fallback.
function slackGroupKey(url: string | undefined, teamGroupMap: TeamGroupMap): string | null {
  if (!url) return null
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (!/(^|\.)slack\.com$/.test(u.hostname)) return null
  const m = u.pathname.match(/\/client\/([TE][A-Z0-9]+)/)
  if (m) return `slack:${teamGroupMap[m[1]] || m[1]}`
  const sub = u.hostname.replace(/\.slack\.com$/, "")
  return sub && sub !== "app" ? `slack:${teamGroupMap[sub] || sub}` : null
}

/** A URL's unread bucket: Slack's per-workspace (or per-Grid-group) `slack:{groupId}`, else
 *  the URL origin. The single key derivation shared by notification keying and Tab/Pin
 *  resolution. `teamGroupMap` merges Enterprise Grid teams; empty map = per-team. */
function groupKeyForUrl(url: string | undefined, teamGroupMap: TeamGroupMap): string | null {
  return slackGroupKey(url, teamGroupMap) ?? originOf(url)
}

/** A notification's group key: its explicit stamped `groupKey` (already merged server-side
 *  for Grid), else derived from its targetUrl — the same derivation Tabs/Pins use. */
function notificationKey(n: UnreadNotification, teamGroupMap: TeamGroupMap): string | null {
  return n.groupKey ?? groupKeyForUrl(n.targetUrl, teamGroupMap)
}

/**
 * Tally unread notifications by group, then resolve each Tab and Pin to its
 * group's count. A Tab resolves through its own `url` origin; a Pin resolves
 * through its linked Tab's live `url` when linked (via `linkedTabByPin`), else
 * its saved `url`. Read notifications and inputs with no resolvable key get `0`.
 *
 * `teamGroupMap` (optional, t092) merges Enterprise Grid Slack teams: a Tab/Pin URL's
 * concrete teamId resolves to its `slack:{groupId}` bucket so an org tab and its member
 * workspace share one count. Notifications already carry the merged `groupKey` from the
 * server, so the map only affects Tab/Pin URL resolution. Omitted/empty = per-team.
 */
export function aggregateUnread(
  notifications: UnreadNotification[],
  tabs: UnreadTab[],
  pins: UnreadPin[],
  linkedTabByPin: Record<string, UnreadTab>,
  teamGroupMap: TeamGroupMap = {},
): UnreadResult {
  const byGroup: Record<string, number> = {}
  for (const n of notifications) {
    if (n.read) continue
    const key = notificationKey(n, teamGroupMap)
    if (key) byGroup[key] = (byGroup[key] || 0) + 1
  }

  const byTab: Record<string, number> = {}
  for (const t of tabs) {
    const key = groupKeyForUrl(t.url, teamGroupMap)
    byTab[t.id] = key ? byGroup[key] || 0 : 0
  }

  const byPin: Record<string, number> = {}
  for (const pin of pins) {
    const key = groupKeyForUrl(linkedTabByPin[pin.id]?.url ?? pin.url, teamGroupMap)
    byPin[pin.id] = key ? byGroup[key] || 0 : 0
  }

  return { byGroup, byTab, byPin }
}
