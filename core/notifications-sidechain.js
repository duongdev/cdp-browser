// Notification Side-Channel: the whole lifecycle + store in one backend-agnostic
// CJS core. Both main.js (Electron) and web/server.mjs consume it; each supplies
// only effects through DI. A per-target read-only CDP socket (no screencast, no
// Input Forwarding — ADR-0003) attaches to every Notification-Adapter-matching Tab,
// injects the adapter's capture script at document-start, and ingests `__cdpNotify`
// toasts through the shared dedup/cap store. Each stored entry is stamped with
// `entry.adapter` (the matched adapter's name) and fired through `onEntry` once.
//
// Pure helpers (dedup, cap, read-model) come from `notifications.js`; this module
// adds the effectful lifecycle around them. It imports no Electron, no node:http,
// no web-push — every effect arrives through `deps`.

const {
  matchAdapter,
  groupKeyFor,
  slackGroupKey,
  ingest,
  markRead,
  markUnread,
  markAllRead,
  unreadCount,
} = require("./notifications")

const NOTIFY_BINDING = "__cdpNotify"
const DEFAULT_CAP = 50

// Notification Adapters identify notification-capable sites by URL hostname. Each
// names its capture script (loaded via the injected `readInject`) and the icon to
// stamp on its entries. Adding an adapter is a one-line config change here.
const ADAPTERS = [
  {
    name: "teams",
    script: "teams-notify.js",
    match: (h) => /(^|\.)teams\.(microsoft|cloud\.microsoft)\.com$/.test(h),
    iconUrl:
      "https://statics.teams.cdn.office.net/evergreen-assets/icons/microsoft_teams_logo_refresh.ico",
  },
  {
    name: "outlook",
    script: "outlook-notify.js",
    match: (h) => /(^|\.)outlook\.(office\.com|live\.com|cloud\.microsoft)$/.test(h),
    iconUrl: "https://outlook.office365.com/owa/favicon.ico",
  },
  {
    name: "slack",
    script: "slack-notify.js",
    match: (h) => /(^|\.)slack\.com$/.test(h),
    iconUrl: "https://a.slack-edge.com/80588/marketing/img/icons/favicon-32-electron.png",
    // Slack runs every workspace under one origin (app.slack.com), so the default
    // per-origin grouping would merge all workspaces into one badge. Derive the group
    // key from the Tab's URL team id instead — one Tab per workspace, so the URL is the
    // authoritative workspace identity (more durable than the in-page capture script).
    groupKey: slackGroupKey,
  },
]

// deps = { readInject, listTargets, load, save, now, WebSocketCtor, onEntry, cap? }
function createNotificationCenter(deps) {
  const { readInject, load, save, WebSocketCtor, onEntry } = deps
  const cap = deps.cap || DEFAULT_CAP

  const adapterFor = (url) => matchAdapter(url, ADAPTERS)
  // Capture-script source is loaded lazily once per adapter and memoized — the same
  // text is reused for every side-channel of that adapter.
  const sourceCache = new Map()
  const sourceFor = (adapter) => {
    if (!sourceCache.has(adapter.name)) sourceCache.set(adapter.name, readInject(adapter.script))
    return sourceCache.get(adapter.name)
  }

  const seeded = load()
  let notifications = Array.isArray(seeded) ? seeded : []
  const persist = () => save(notifications)

  const sideChannels = new Map() // targetId -> ws

  function handleToast(raw, target) {
    let n
    try {
      n = JSON.parse(raw)
    } catch {
      return
    }
    if (!n || typeof n !== "object") return
    const adapter = adapterFor(target.url)
    const { list, entry } = ingest(
      notifications,
      {
        id: n.id,
        adapter: adapter ? adapter.name : null,
        // Stable grouping key — an adapter's URL-derived key (e.g. Slack's per-workspace
        // `slack:{teamId}`) wins; else the capture script's explicit groupKey, else the
        // Tab's URL origin (today's per-origin grouping). Consumers key on this, never origin.
        groupKey: adapter?.groupKey?.(target.url) || groupKeyFor(n, target.url),
        source: n.source || "",
        title: n.title || "",
        body: n.body || "",
        targetId: target.id,
        targetUrl: target.url,
        // Normalized deep-open intent (semantic ids only). Pass through untouched; the
        // renderer's activation registry dispatches it. Legacy targetEntity stays for
        // back-compatible display.
        activate: n.activate || null,
        targetEntity: n.targetEntity || null,
        icon: (adapter || {}).iconUrl || null,
        ts: n.ts || (deps.now ? deps.now() : Date.now()),
      },
      cap,
    )
    if (!entry) return // rejected: missing id or duplicate (cross-tab / headless+client safe)
    notifications = list
    persist()
    onEntry(entry)
  }

  function attach(target) {
    const adapter = adapterFor(target.url)
    if (!adapter || !target.webSocketDebuggerUrl) return
    const ws = new WebSocketCtor(target.webSocketDebuggerUrl)
    sideChannels.set(target.id, ws)
    let cmdId = 1
    const cdp = (method, params) =>
      ws.send(JSON.stringify({ id: cmdId++, method, params: params || {} }))
    ws.on("open", () => {
      cdp("Runtime.enable")
      cdp("Page.enable")
      cdp("Runtime.addBinding", { name: NOTIFY_BINDING })
      // document-start for future loads + the already-loaded document.
      cdp("Page.addScriptToEvaluateOnNewDocument", { source: sourceFor(adapter) })
      cdp("Runtime.evaluate", { expression: sourceFor(adapter) })
    })
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.method === "Runtime.bindingCalled" && msg.params.name === NOTIFY_BINDING) {
          handleToast(msg.params.payload, target)
        }
      } catch {}
    })
    const drop = () => {
      if (sideChannels.get(target.id) === ws) sideChannels.delete(target.id)
    }
    ws.on("close", drop)
    ws.on("error", drop)
  }

  // Attach to newly-seen adapter-matching Tab targets, drop vanished/changed ones.
  // `targets` is optional; when omitted, the injected `listTargets()` is called.
  async function reconcile(targets) {
    let list = targets
    if (!Array.isArray(list)) {
      try {
        list = await deps.listTargets()
      } catch {
        return
      }
    }
    if (!Array.isArray(list)) return
    const matched = list.filter((t) => t.type === "page" && adapterFor(t.url))
    const liveIds = new Set(matched.map((t) => t.id))
    for (const [id, ws] of sideChannels) {
      if (!liveIds.has(id)) {
        try {
          ws.close()
        } catch {}
        sideChannels.delete(id)
      }
    }
    for (const t of matched) if (!sideChannels.has(t.id)) attach(t)
  }

  return {
    adapterFor,
    reconcile,
    list: () => notifications,
    markRead: (id) => {
      notifications = markRead(notifications, id)
      persist()
      return notifications
    },
    markUnread: (id) => {
      notifications = markUnread(notifications, id)
      persist()
      return notifications
    },
    markAllRead: () => {
      notifications = markAllRead(notifications)
      persist()
      return notifications
    },
    clear: () => {
      notifications = []
      persist()
      return notifications
    },
    unreadCount: () => unreadCount(notifications),
    close: () => {
      for (const [, ws] of sideChannels) {
        try {
          ws.close()
        } catch {}
      }
      sideChannels.clear()
    },
  }
}

module.exports = { createNotificationCenter, ADAPTERS, NOTIFY_BINDING }
