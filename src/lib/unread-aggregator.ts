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

// Slack runs every workspace under one origin (app.slack.com), so resolving a Slack
// tab/pin by origin would merge all workspaces into one badge. Key it by team id instead
// — matching the `slack:{teamId}` group key the notification center stamps server-side
// (mirrors core/notifications.js `slackGroupKey`; one tab per workspace, so the URL is
// authoritative). `T…` standard / `E…` Enterprise Grid, legacy subdomain fallback.
function slackGroupKey(url: string | undefined): string | null {
  if (!url) return null
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (!/(^|\.)slack\.com$/.test(u.hostname)) return null
  const m = u.pathname.match(/\/client\/([TE][A-Z0-9]+)/)
  if (m) return `slack:${m[1]}`
  const sub = u.hostname.replace(/\.slack\.com$/, "")
  return sub && sub !== "app" ? `slack:${sub}` : null
}

/** A URL's unread bucket: Slack's per-workspace `slack:{teamId}`, else the URL origin.
 *  The single key derivation shared by notification keying and Tab/Pin resolution. */
function groupKeyForUrl(url: string | undefined): string | null {
  return slackGroupKey(url) ?? originOf(url)
}

/** A notification's group key: its explicit stamped `groupKey`, else derived from its
 *  targetUrl (Slack workspace key or origin) — the same derivation Tabs/Pins use. */
function notificationKey(n: UnreadNotification): string | null {
  return n.groupKey ?? groupKeyForUrl(n.targetUrl)
}

/**
 * Tally unread notifications by group, then resolve each Tab and Pin to its
 * group's count. A Tab resolves through its own `url` origin; a Pin resolves
 * through its linked Tab's live `url` when linked (via `linkedTabByPin`), else
 * its saved `url`. Read notifications and inputs with no resolvable key get `0`.
 */
export function aggregateUnread(
  notifications: UnreadNotification[],
  tabs: UnreadTab[],
  pins: UnreadPin[],
  linkedTabByPin: Record<string, UnreadTab>,
): UnreadResult {
  const byGroup: Record<string, number> = {}
  for (const n of notifications) {
    if (n.read) continue
    const key = notificationKey(n)
    if (key) byGroup[key] = (byGroup[key] || 0) + 1
  }

  const byTab: Record<string, number> = {}
  for (const t of tabs) {
    const key = groupKeyForUrl(t.url)
    byTab[t.id] = key ? byGroup[key] || 0 : 0
  }

  const byPin: Record<string, number> = {}
  for (const pin of pins) {
    const key = groupKeyForUrl(linkedTabByPin[pin.id]?.url ?? pin.url)
    byPin[pin.id] = key ? byGroup[key] || 0 : 0
  }

  return { byGroup, byTab, byPin }
}
