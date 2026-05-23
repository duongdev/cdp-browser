// Pure notification logic shared by main.js (effects: WS, Electron Notification,
// persistence, IPC live in main.js). Mirrors the "pure reducer, effects in caller"
// pattern of src/lib/adaptive-viewport.ts, but as CommonJS since the Electron main
// process can't import the renderer's TS/ESM modules. Tested by notifications.test.ts.

// Returns the first adapter whose `match(hostname)` accepts the URL's host, or null.
function matchAdapter(url, adapters) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  return adapters.find((a) => a.match(host)) || null;
}

// Stamps a payload as unread and prepends it (newest-first). Returns the new list
// and the created entry (entry is null when the payload is rejected).
function ingest(list, payload, cap) {
  if (!payload || !payload.id) return { list, entry: null };
  if (list.some((e) => e.id === payload.id)) return { list, entry: null };
  const entry = { ...payload, read: false };
  return { list: [entry, ...list].slice(0, cap), entry };
}

// OS toast fires unless you can already see the site's own in-app toast — i.e. its
// tab is the active one AND the app window is focused. If you've switched tabs or
// alt-tabbed to another app, the in-app toast is out of view, so the OS toast fires.
function shouldNotifyOs(entry, { activeTabId, enabled, windowFocused }) {
  if (!enabled) return false;
  const inView = entry.targetId === activeTabId && windowFocused;
  return !inView;
}

function markRead(list, id) {
  return list.map((n) => (n.id === id ? { ...n, read: true } : n));
}

function markAllRead(list) {
  return list.map((n) => (n.read ? n : { ...n, read: true }));
}

function unreadCount(list) {
  return list.reduce((acc, n) => acc + (n.read ? 0 : 1), 0);
}

// { [targetId]: unreadCount } — only targets with at least one unread appear.
function unreadByTarget(list) {
  const out = {};
  for (const n of list) {
    if (!n.read) out[n.targetId] = (out[n.targetId] || 0) + 1;
  }
  return out;
}

module.exports = {
  matchAdapter,
  ingest,
  shouldNotifyOs,
  markRead,
  markAllRead,
  unreadCount,
  unreadByTarget,
};
