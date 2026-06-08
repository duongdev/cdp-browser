// Pure notification logic shared by main.js (effects: WS, Electron Notification,
// persistence, IPC live in main.js). Mirrors the "pure reducer, effects in caller"
// pattern of src/lib/adaptive-viewport.ts, but as CommonJS since the Electron main
// process can't import the renderer's TS/ESM modules. Tested by notifications.test.ts.

// Returns the first adapter whose `match(hostname)` accepts the URL's host, or null.
function matchAdapter(url, adapters) {
  let host
  try {
    host = new URL(url).hostname
  } catch {
    return null
  }
  return adapters.find((a) => a.match(host)) || null
}

// The origin of a URL, or null when it has none / is unparseable.
function originOf(url) {
  if (!url) return null
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

// The stable group key for a captured notification: the capture script's explicit
// `groupKey` when present, else the owning Tab's URL origin. Keying everything on this
// (with origin as the default) preserves today's per-origin grouping exactly, while a
// future adapter can emit e.g. "slack:{teamId}" to split workspaces with no consumer
// change. Returns "" when neither is resolvable (an unkeyable entry).
function groupKeyFor(payload, targetUrl) {
  const explicit = payload?.groupKey
  if (explicit) return explicit
  return originOf(targetUrl) || ""
}

// Slack workspace context from a tab URL. Modern Slack runs every workspace under one
// origin (`app.slack.com/client/{TEAM}/{CHANNEL}`), so per-origin grouping can't tell
// workspaces apart — the team id (path segment, `T…` standard or `E…` Enterprise Grid)
// is the real key. Legacy `acme.slack.com` URLs fall back to the subdomain as the team
// id. Returns nulls for non-Slack / unparseable URLs. Pure.
function parseSlackContext(url) {
  let u
  try {
    u = new URL(url)
  } catch {
    return { teamId: null, channelId: null }
  }
  if (!/(^|\.)slack\.com$/.test(u.hostname)) return { teamId: null, channelId: null }
  const m = u.pathname.match(/\/client\/([TE][A-Z0-9]+)(?:\/([CDG][A-Z0-9]+))?/)
  if (m) return { teamId: m[1], channelId: m[2] || null }
  // Legacy per-workspace subdomain (acme.slack.com) — not app.slack.com.
  const sub = u.hostname.replace(/\.slack\.com$/, "")
  if (sub && sub !== "app" && sub !== "slack.com") return { teamId: sub, channelId: null }
  return { teamId: null, channelId: null }
}

// The per-workspace group key for a Slack tab URL: `slack:{teamId}`, or "" when no team
// id is resolvable (an unkeyable entry, like `groupKeyFor`'s empty case). Wired as the
// Slack adapter's `groupKey(url)` hook so unread bucketing splits by workspace even
// though every workspace shares the app.slack.com origin. Pure.
function slackGroupKey(url) {
  const { teamId } = parseSlackContext(url)
  return teamId ? `slack:${teamId}` : ""
}

// Stamps a payload as unread and prepends it (newest-first). Returns the new list
// and the created entry (entry is null when the payload is rejected).
function ingest(list, payload, cap) {
  if (!payload?.id) return { list, entry: null }
  if (list.some((e) => e.id === payload.id)) return { list, entry: null }
  const entry = { ...payload, read: false }
  return { list: [entry, ...list].slice(0, cap), entry }
}

// OS toast fires unless you can already see the site's own in-app toast — i.e. its
// tab is the active one AND the app window is focused. If you've switched tabs or
// alt-tabbed to another app, the in-app toast is out of view, so the OS toast fires.
function shouldNotifyOs(entry, { activeTabId, enabled, windowFocused }) {
  if (!enabled) return false
  const inView = entry.targetId === activeTabId && windowFocused
  return !inView
}

function markRead(list, id) {
  return list.map((n) => (n.id === id ? { ...n, read: true } : n))
}

function markUnread(list, id) {
  return list.map((n) => (n.id === id ? { ...n, read: false } : n))
}

function markAllRead(list) {
  return list.map((n) => (n.read ? n : { ...n, read: true }))
}

function unreadCount(list) {
  return list.reduce((acc, n) => acc + (n.read ? 0 : 1), 0)
}

// The favicon to overlay on the app's dock icon: the icon of the most-recent UNREAD
// notification (the list is newest-first), or null when nothing is unread (clear the
// overlay, restore the plain app icon). Pure — main.js owns the image composite +
// app.dock.setIcon effect. See t066.
function dockOverlayIcon(list) {
  const newestUnread = list.find((n) => !n.read)
  return newestUnread?.icon || null
}

// { [targetId]: unreadCount } — only targets with at least one unread appear.
function unreadByTarget(list) {
  const out = {}
  for (const n of list) {
    if (!n.read) out[n.targetId] = (out[n.targetId] || 0) + 1
  }
  return out
}

module.exports = {
  matchAdapter,
  groupKeyFor,
  parseSlackContext,
  slackGroupKey,
  ingest,
  shouldNotifyOs,
  dockOverlayIcon,
  markRead,
  markUnread,
  markAllRead,
  unreadCount,
  unreadByTarget,
}
