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
    // Slack delivers many notifications from its service worker's `push` handler
    // (`registration.showNotification`), a realm the page hook can't reach. `swScript`
    // is injected into the matching service_worker target to patch showNotification there
    // and ship the same `__cdpNotify` toasts (t067). The SW URL carries no team id, so the
    // script derives the per-workspace groupKey from the notification payload instead.
    swScript: "slack-sw-notify.js",
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
  // Service-worker capture script, memoized per adapter (separate cache key so it never
  // collides with the page `script`). Only adapters that declare `swScript` have one.
  const swSourceCache = new Map()
  const swSourceFor = (adapter) => {
    if (!swSourceCache.has(adapter.name)) {
      swSourceCache.set(adapter.name, readInject(adapter.swScript))
    }
    return swSourceCache.get(adapter.name)
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
        icon: adapter?.iconUrl || null,
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
    let cmdId = 1
    let opened = false
    const cdp = (method, params) =>
      ws.send(JSON.stringify({ id: cmdId++, method, params: params || {} }))
    // Keep the remote Tab's page alive so its capture script keeps firing even when the
    // Tab is backgrounded on the remote browser. Chromium freezes idle background tabs
    // (~5 min), which pauses the page JS that calls `new Notification()` — so background
    // Tabs silently stop delivering toasts (the asymmetry where only the active Tab
    // notified). Forcing the web lifecycle to "active" prevents the freeze WITHOUT making
    // the page "visible" (visibility is orthogonal in the CDP spec — verified against
    // Page.setWebLifecycleState, which only takes "frozen"|"active"), so Slack still treats
    // the Tab as hidden and keeps firing desktop notifications for the side-channel to
    // capture. Re-applied every reconcile because the browser can re-freeze. See t066.
    const keepAlive = () => {
      if (opened) cdp("Page.setWebLifecycleState", { state: "active" })
    }
    sideChannels.set(target.id, { ws, keepAlive })
    ws.on("open", () => {
      opened = true
      cdp("Runtime.enable")
      cdp("Page.enable")
      cdp("Runtime.addBinding", { name: NOTIFY_BINDING })
      // document-start for future loads + the already-loaded document.
      cdp("Page.addScriptToEvaluateOnNewDocument", { source: sourceFor(adapter) })
      cdp("Runtime.evaluate", { expression: sourceFor(adapter) })
      keepAlive()
    })
    wireToastAndDrop(ws, target)
  }

  // Service-worker side-channel (t067). Slack/Teams/Outlook deliver many notifications from
  // their service worker's `push` handler via `registration.showNotification` — a realm the
  // page hook (`window.Notification`) can't reach. A service_worker target supports Runtime
  // (not Page), so we patch via a one-shot Runtime.evaluate into the running worker rather
  // than Page.addScriptToEvaluateOnNewDocument. Best-effort: a worker that spins up fresh on
  // a push and fires before the next 5s reconcile attaches is missed (no SW-start barrier
  // here). The page keep-alive (t066) keeps the registration warm, which keeps the worker
  // listed in /json across reconciles. No keep-alive on the worker itself (no web lifecycle).
  function attachServiceWorker(target) {
    const adapter = adapterFor(target.url)
    if (!adapter?.swScript || !target.webSocketDebuggerUrl) return
    const ws = new WebSocketCtor(target.webSocketDebuggerUrl)
    let cmdId = 1
    const cdp = (method, params) =>
      ws.send(JSON.stringify({ id: cmdId++, method, params: params || {} }))
    sideChannels.set(target.id, { ws, keepAlive: () => {} })
    ws.on("open", () => {
      cdp("Runtime.enable")
      cdp("Runtime.addBinding", { name: NOTIFY_BINDING })
      cdp("Runtime.evaluate", { expression: swSourceFor(adapter) })
    })
    wireToastAndDrop(ws, target)
  }

  // Shared toast ingest + self-removal wiring for both the page and service-worker channels.
  function wireToastAndDrop(ws, target) {
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.method === "Runtime.bindingCalled" && msg.params.name === NOTIFY_BINDING) {
          handleToast(msg.params.payload, target)
        }
      } catch {}
    })
    const drop = () => {
      const cur = sideChannels.get(target.id)
      if (cur && cur.ws === ws) sideChannels.delete(target.id)
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
    const pages = list.filter((t) => t.type === "page" && adapterFor(t.url))
    // Service-worker targets whose adapter declares a swScript (t067).
    const workers = list.filter((t) => t.type === "service_worker" && adapterFor(t.url)?.swScript)
    const liveIds = new Set([...pages, ...workers].map((t) => t.id))
    for (const [id, { ws }] of sideChannels) {
      if (!liveIds.has(id)) {
        try {
          ws.close()
        } catch {}
        sideChannels.delete(id)
      }
    }
    for (const t of pages) if (!sideChannels.has(t.id)) attach(t)
    for (const t of workers) if (!sideChannels.has(t.id)) attachServiceWorker(t)
    // Re-apply keep-alive to every live side-channel each cycle — the browser may have
    // re-frozen a backgrounded Tab since the last pass (t066). SW channels no-op.
    for (const [, ch] of sideChannels) ch.keepAlive()
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
      for (const [, { ws }] of sideChannels) {
        try {
          ws.close()
        } catch {}
      }
      sideChannels.clear()
    },
  }
}

module.exports = { createNotificationCenter, ADAPTERS, NOTIFY_BINDING }
