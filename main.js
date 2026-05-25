const {
  app,
  BaseWindow,
  WebContentsView,
  ipcMain,
  nativeTheme,
  clipboard,
  Notification,
  Menu,
  session,
  desktopCapturer,
  systemPreferences,
  dialog,
} = require("electron")
const path = require("path")
const fs = require("fs")
const WebSocket = require("ws")
const { emulatedMediaParams } = require("./theme-emulation")

// The window is a BaseWindow composed of a chrome view (the React UI, full
// window) layered over zero-or-more local-tab page views. `chromeView` hosts
// everything the renderer draws — including the CDP screencast canvas — so all
// `webContents.send`/`isFocused` that used to target the BrowserWindow now go
// through the chrome view. See docs/adr/0005.
let mainWindow
let chromeView
const chromeWc = () => chromeView && chromeView.webContents
function chromeSend(channel, ...args) {
  const wc = chromeWc()
  if (wc && !wc.isDestroyed()) wc.send(channel, ...args)
}
let activeWs = null
let activeTabId = null
let connectId = 0
// Last device-metrics override the renderer applied. Re-sent on every (re)connect
// before the screencast starts so a tab switch lands already sized — no native-size
// first frame and the resulting jiggle. Cleared when the override is cleared.
let cachedMetrics = null

// Settings persistence
const settingsPath = path.join(app.getPath("userData"), "settings.json")

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath, "utf8"))
  } catch {
    return { host: "localhost", port: 9222, themeSource: "system" }
  }
}

function saveSettings(settings) {
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
}

const settings = loadSettings()

// Migrate the legacy boolean `switchBlur` to the `switchEffect` enum.
if (settings.switchEffect === undefined && settings.switchBlur !== undefined) {
  settings.switchEffect = settings.switchBlur ? "blur" : "none"
  delete settings.switchBlur
  saveSettings(settings)
}

// Migrate legacy `bookmarks` to `pins` (pins are live-tab holders; the saved
// fields are a superset of a bookmark, so the array carries over verbatim).
if (settings.pins === undefined && settings.bookmarks !== undefined) {
  settings.pins = settings.bookmarks
  delete settings.bookmarks
  saveSettings(settings)
}

let cdpHost = settings.host
let cdpPort = settings.port

// When Adaptive Viewport is on we override the remote's device metrics. The renderer
// can't reliably clear them on a tab switch (the socket is torn down first), so the
// main process clears on the outgoing socket — otherwise the host browser stays
// pinned to our emulated size when the user drives it directly.
function clearAdaptiveOverride(ws) {
  if (!settings.adaptiveViewport) return
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  try {
    ws.send(
      JSON.stringify({ id: cmdId++, method: "Emulation.clearDeviceMetricsOverride", params: {} }),
    )
  } catch (e) {}
}

// Push the app's resolved light/dark scheme to the remote page so sites (and extensions)
// that read `prefers-color-scheme` follow the shell theme. Pure mapping in theme-emulation.js.
function applyThemeEmulation(ws) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  const params = emulatedMediaParams(settings.syncTheme ?? true, nativeTheme.shouldUseDarkColors)
  try {
    ws.send(JSON.stringify({ id: cmdId++, method: "Emulation.setEmulatedMedia", params }))
  } catch (e) {}
}

// Dev mode is signalled explicitly by the `dev` script (ELECTRON_DEV=1), not inferred
// from a missing dist/ — a leftover build must not silently force the prod bundle and
// hide live Vite edits. `start`/`preview` run electron without the flag → load dist.
const isDev = !app.isPackaged && process.env.ELECTRON_DEV === "1"

// The renderer forwards keystrokes to the Active Tab and `preventDefault`s them,
// which suppresses menu accelerators (this is why Cmd+R reloads the remote page, not
// the shell). The Viewport now lets OS-reserved combos fall through (see
// src/lib/key-routing.ts); this menu gives them the standard macOS roles to land on —
// Hide/Hide Others/Quit, Minimize/Zoom, Fullscreen. Content combos the renderer keeps
// (Cmd+R/W/C/V/…) stay suppressed before the menu ever sees them, so no conflict.
function buildAppMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: "appMenu" },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ]),
  )
}

app.whenReady().then(() => {
  buildAppMenu()
  nativeTheme.themeSource = settings.themeSource || "system"

  mainWindow = new BaseWindow({
    width: 1400,
    height: 900,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 12, y: 12 },
    vibrancy: "sidebar",
  })

  chromeView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  })
  // Transparent so the window's sidebar vibrancy can show through wherever the
  // renderer leaves a translucent surface.
  chromeView.setBackgroundColor("#00000000")
  mainWindow.contentView.addChildView(chromeView)
  fitChromeView()
  mainWindow.on("resize", fitChromeView)

  if (isDev) {
    chromeView.webContents.loadURL("http://localhost:5173")
  } else {
    chromeView.webContents.loadFile(path.join(__dirname, "dist", "index.html"))
  }

  setupLocalSession()

  // Notify renderer when native theme changes
  nativeTheme.on("updated", () => {
    chromeSend("cdp:native-theme-changed", nativeTheme.shouldUseDarkColors)
    applyThemeEmulation(activeWs)
  })

  // Trackpad swipe gestures (macOS)
  mainWindow.on("swipe", (_, direction) => {
    chromeSend("cdp:swipe", direction)
  })
})

// The chrome view always fills the whole window (it draws the sidebar/toolbar
// and the CDP canvas). Local page views are positioned over the viewport hole.
function fitChromeView() {
  if (!mainWindow || !chromeView) return
  const { width, height } = mainWindow.getContentBounds()
  chromeView.setBounds({ x: 0, y: 0, width, height })
}

ipcMain.handle("cdp:copy-to-clipboard", (_, text) => {
  clipboard.writeText(text)
})

ipcMain.handle("cdp:list-tabs", async () => {
  try {
    const res = await fetch(`http://${cdpHost}:${cdpPort}/json`)
    return await res.json()
  } catch (e) {
    return { error: e.message }
  }
})

ipcMain.handle("cdp:new-tab", async (_, url) => {
  try {
    const res = await fetch(`http://${cdpHost}:${cdpPort}/json/new?${url || "about:blank"}`, {
      method: "PUT",
    })
    return await res.json()
  } catch (e) {
    return { error: e.message }
  }
})

ipcMain.handle("cdp:close-tab", async (_, tabId) => {
  try {
    await fetch(`http://${cdpHost}:${cdpPort}/json/close/${tabId}`)
    return { ok: true }
  } catch (e) {
    return { error: e.message }
  }
})

ipcMain.handle("cdp:connect", async (_, tabId) => {
  // Close previous
  if (activeWs) {
    const old = activeWs
    activeWs = null
    clearAdaptiveOverride(old)
    try {
      old.close()
    } catch (e) {}
  }

  const myId = ++connectId
  activeTabId = tabId

  try {
    // Activate the tab first
    await fetch(`http://${cdpHost}:${cdpPort}/json/activate/${tabId}`)

    // Small delay for activation
    await new Promise((r) => setTimeout(r, 200))

    if (myId !== connectId) return { error: "cancelled" }

    const res = await fetch(`http://${cdpHost}:${cdpPort}/json`)
    const tabs = await res.json()
    const tab = tabs.find((t) => t.id === tabId)
    if (!tab) return { error: "Tab not found" }

    return new Promise((resolve) => {
      console.log("Connecting to:", tab.webSocketDebuggerUrl)
      const ws = new WebSocket(tab.webSocketDebuggerUrl)

      ws.on("open", () => {
        if (myId !== connectId) {
          ws.close()
          return resolve({ error: "cancelled" })
        }
        activeWs = ws
        resolve({ ok: true })

        const bounds = mainWindow.getBounds()
        ws.send(JSON.stringify({ id: 1, method: "Page.enable", params: {} }))
        ws.send(JSON.stringify({ id: 2, method: "Input.enable", params: {} }))
        applyThemeEmulation(ws)
        // Re-apply the cached adaptive override before the screencast so the first
        // frame is already sized to the window — prevents the tab-switch jiggle.
        if (settings.adaptiveViewport && cachedMetrics) {
          ws.send(
            JSON.stringify({
              id: 5,
              method: "Emulation.setDeviceMetricsOverride",
              params: cachedMetrics,
            }),
          )
        } else if (!settings.adaptiveViewport) {
          // Adaptive is off: release any device-metrics override a prior crash left
          // pinned on the host. A clean quit clears it; a force-kill can't. A bare clear
          // is a no-op on an override owned by the now-dead session, so first re-assert
          // one (taking ownership in this session), then clear it — releasing to native.
          const b = mainWindow.getBounds()
          ws.send(
            JSON.stringify({
              id: 5,
              method: "Emulation.setDeviceMetricsOverride",
              params: { width: b.width, height: b.height, deviceScaleFactor: 1, mobile: false },
            }),
          )
          ws.send(
            JSON.stringify({ id: 6, method: "Emulation.clearDeviceMetricsOverride", params: {} }),
          )
        }
        ws.send(
          JSON.stringify({
            id: 3,
            method: "Page.startScreencast",
            params: {
              format: "jpeg",
              quality: 80,
              maxWidth: bounds.width * 2,
              maxHeight: bounds.height * 2,
            },
          }),
        )
        // Suppress native context menu (invisible in screencast and blocks interaction)
        ws.send(
          JSON.stringify({
            id: 4,
            method: "Runtime.evaluate",
            params: {
              expression: "document.addEventListener('contextmenu', e => e.preventDefault(), true)",
            },
          }),
        )
      })

      ws.on("message", (data) => {
        if (activeWs !== ws) return
        try {
          const msg = JSON.parse(data.toString())
          chromeSend("cdp:event", msg)
        } catch (e) {}
      })

      ws.on("close", () => {
        if (activeWs === ws) activeWs = null
        chromeSend("cdp:disconnected")
      })

      ws.on("error", (err) => {
        console.error("WS error:", err.message)
        if (activeWs === ws) activeWs = null
        resolve({ error: err.message })
      })
    })
  } catch (e) {
    return { error: e.message }
  }
})

let cmdId = 100
ipcMain.on("cdp:send", (_, method, params) => {
  if (method === "Emulation.setDeviceMetricsOverride") cachedMetrics = params
  else if (method === "Emulation.clearDeviceMetricsOverride") cachedMetrics = null
  if (activeWs && activeWs.readyState === WebSocket.OPEN) {
    activeWs.send(JSON.stringify({ id: cmdId++, method, params: params || {} }))
  }
})

ipcMain.handle("cdp:invoke", async (_, method, params) => {
  if (!activeWs || activeWs.readyState !== WebSocket.OPEN) {
    return { error: "not connected" }
  }
  const id = cmdId++
  return new Promise((resolve) => {
    const handler = (data) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.id === id) {
          activeWs.off("message", handler)
          resolve(msg.result || {})
        }
      } catch (e) {}
    }
    activeWs.on("message", handler)
    activeWs.send(JSON.stringify({ id, method, params: params || {} }))
    setTimeout(() => {
      activeWs?.off("message", handler)
      resolve({ error: "timeout" })
    }, 3000)
  })
})

ipcMain.handle("cdp:config", () => ({ host: cdpHost, port: cdpPort }))

ipcMain.handle("cdp:test-config", async (_, config) => {
  try {
    const res = await fetch(`http://${config.host}:${config.port}/json/version`, {
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return { error: `HTTP ${res.status}` }
    const info = await res.json()
    return { ok: true, browser: info.Browser || "Unknown browser" }
  } catch (e) {
    return { error: e.name === "TimeoutError" ? "Connection timed out" : e.message }
  }
})

ipcMain.handle("cdp:set-config", (_, config) => {
  cdpHost = config.host
  cdpPort = config.port
  settings.host = config.host
  settings.port = config.port
  saveSettings(settings)
})

ipcMain.handle("cdp:get-sidebar-width", () => settings.sidebarWidth || 220)

ipcMain.handle("cdp:set-sidebar-width", (_, width) => {
  settings.sidebarWidth = width
  saveSettings(settings)
})

ipcMain.handle("cdp:get-ui-state", () => ({
  sidebarCollapsed: settings.sidebarCollapsed ?? false,
  pinnedOpen: settings.pinnedOpen ?? true,
  adaptiveViewport: settings.adaptiveViewport ?? false,
  forceOnClient: settings.forceOnClient ?? false,
  switchEffect: settings.switchEffect ?? "blur",
  notificationsEnabled: settings.notificationsEnabled ?? true,
  syncTheme: settings.syncTheme ?? true,
  autoGrantLocalMedia: settings.autoGrantLocalMedia ?? true,
  restoreLocalPins: settings.restoreLocalPins ?? true,
  localExtensionPaths: settings.localExtensionPaths ?? [],
}))

ipcMain.handle("cdp:set-ui-state", (_, partial) => {
  if ("sidebarCollapsed" in partial) settings.sidebarCollapsed = partial.sidebarCollapsed
  if ("pinnedOpen" in partial) settings.pinnedOpen = partial.pinnedOpen
  if ("adaptiveViewport" in partial) settings.adaptiveViewport = partial.adaptiveViewport
  if ("forceOnClient" in partial) settings.forceOnClient = partial.forceOnClient
  if ("switchEffect" in partial) settings.switchEffect = partial.switchEffect
  if ("notificationsEnabled" in partial)
    settings.notificationsEnabled = partial.notificationsEnabled
  if ("syncTheme" in partial) {
    settings.syncTheme = partial.syncTheme
    applyThemeEmulation(activeWs)
  }
  if ("autoGrantLocalMedia" in partial) settings.autoGrantLocalMedia = partial.autoGrantLocalMedia
  if ("restoreLocalPins" in partial) settings.restoreLocalPins = partial.restoreLocalPins
  saveSettings(settings)
})

// Pins (live-tab holders). The renderer owns link state (`targetId`); main is the
// persistent store. `reorder-pins` replaces the whole array, so it also persists
// link/unlink changes.
ipcMain.handle("cdp:get-pins", () => {
  return settings.pins || []
})

ipcMain.handle("cdp:add-pin", (_, pin) => {
  if (!settings.pins) settings.pins = []
  // Avoid duplicates by URL
  if (!settings.pins.some((p) => p.url === pin.url)) {
    settings.pins.push(pin)
    saveSettings(settings)
  }
  return settings.pins
})

ipcMain.handle("cdp:update-pin", (_, id, patch) => {
  if (!settings.pins) settings.pins = []
  settings.pins = settings.pins.map((p) =>
    p.id === id ? { ...p, title: patch.title, url: patch.url } : p,
  )
  saveSettings(settings)
  return settings.pins
})

ipcMain.handle("cdp:remove-pin", (_, id) => {
  if (!settings.pins) settings.pins = []
  settings.pins = settings.pins.filter((p) => p.id !== id)
  saveSettings(settings)
  return settings.pins
})

ipcMain.handle("cdp:reorder-pins", (_, pins) => {
  settings.pins = pins
  saveSettings(settings)
  return settings.pins
})

ipcMain.handle("cdp:set-theme-source", (_, source) => {
  nativeTheme.themeSource = source
  settings.themeSource = source
  saveSettings(settings)
})

ipcMain.handle("cdp:get-theme-source", () => {
  return settings.themeSource || "system"
})

// ---------------------------------------------------------------------------
// Notifications: per-target read-only side-channels capture each site's in-app
// toast (independent of the active-tab screencast socket). See docs/adr/0003.
// ---------------------------------------------------------------------------

// Adapters identify notification-capable sites by URL host. The injected script
// (per adapter) ships captures through the `__cdpNotify` binding.
const {
  matchAdapter,
  ingest,
  shouldNotifyOs,
  markRead,
  markUnread,
  markAllRead,
  unreadCount,
} = require("./notifications")
const NOTIFY_BINDING = "__cdpNotify"
const injectSource = fs.readFileSync(path.join(__dirname, "inject", "teams-notify.js"), "utf8")
const outlookSource = fs.readFileSync(path.join(__dirname, "inject", "outlook-notify.js"), "utf8")
const ADAPTERS = [
  {
    name: "teams",
    match: (h) => /(^|\.)teams\.(microsoft|cloud\.microsoft)\.com$/.test(h),
    source: injectSource,
    iconUrl:
      "https://statics.teams.cdn.office.net/evergreen-assets/icons/microsoft_teams_logo_refresh.ico",
  },
  {
    name: "outlook",
    match: (h) => /(^|\.)outlook\.(office\.com|live\.com|cloud\.microsoft)$/.test(h),
    source: outlookSource,
    iconUrl: "https://outlook.office365.com/owa/favicon.ico",
  },
]
const adapterFor = (url) => matchAdapter(url, ADAPTERS)

// Persisted store (separate from settings.json to keep that file lean).
const notificationsPath = path.join(app.getPath("userData"), "notifications.json")
let notifications = (() => {
  try {
    return JSON.parse(fs.readFileSync(notificationsPath, "utf8"))
  } catch {
    return []
  }
})()
const NOTIF_CAP = 50
function saveNotifications() {
  try {
    fs.writeFileSync(notificationsPath, JSON.stringify(notifications))
  } catch (e) {}
}

// Dock badge mirrors total unread (macOS). 0 clears it.
function updateBadge() {
  if (typeof app.setBadgeCount === "function") app.setBadgeCount(unreadCount(notifications))
}

const sideChannels = new Map() // targetId -> ws

function ingestNotification(raw, targetId, targetUrl) {
  let n
  try {
    n = JSON.parse(raw)
  } catch {
    return
  }
  if (!n || typeof n !== "object") return
  const { list, entry } = ingest(
    notifications,
    {
      id: n.id,
      source: n.source || "",
      title: n.title || "",
      body: n.body || "",
      targetId,
      targetUrl,
      targetEntity: n.targetEntity || null,
      icon: (adapterFor(targetUrl) || {}).iconUrl || null,
      ts: n.ts || Date.now(),
    },
    NOTIF_CAP,
  )
  if (!entry) return // rejected: missing id or duplicate (cross-tab safe)
  notifications = list
  saveNotifications()
  updateBadge()

  chromeSend("cdp:notification", entry)

  const windowFocused = !!(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused())
  if (
    shouldNotifyOs(entry, {
      activeTabId,
      enabled: settings.notificationsEnabled ?? true,
      windowFocused,
    }) &&
    Notification.isSupported()
  ) {
    const osN = new Notification({ title: entry.title || entry.source, body: entry.body })
    osN.on("click", () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show()
        mainWindow.focus()
        chromeSend("cdp:notification-activate", entry)
      }
    })
    osN.show()
  }
}

function attachSideChannel(target) {
  const adapter = adapterFor(target.url)
  if (!adapter || !target.webSocketDebuggerUrl) return
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  sideChannels.set(target.id, ws)
  ws.on("open", () => {
    ws.send(JSON.stringify({ id: 1, method: "Runtime.enable", params: {} }))
    ws.send(JSON.stringify({ id: 2, method: "Page.enable", params: {} }))
    ws.send(
      JSON.stringify({ id: 3, method: "Runtime.addBinding", params: { name: NOTIFY_BINDING } }),
    )
    // Future loads (document-start) + the already-loaded document.
    ws.send(
      JSON.stringify({
        id: 4,
        method: "Page.addScriptToEvaluateOnNewDocument",
        params: { source: adapter.source },
      }),
    )
    ws.send(
      JSON.stringify({ id: 5, method: "Runtime.evaluate", params: { expression: adapter.source } }),
    )
  })
  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString())
      if (msg.method === "Runtime.bindingCalled" && msg.params.name === NOTIFY_BINDING) {
        ingestNotification(msg.params.payload, target.id, target.url)
      }
    } catch (e) {}
  })
  ws.on("close", () => {
    if (sideChannels.get(target.id) === ws) sideChannels.delete(target.id)
  })
  ws.on("error", () => {
    if (sideChannels.get(target.id) === ws) sideChannels.delete(target.id)
  })
}

// Poll /json: attach to newly-seen matching targets, drop vanished ones.
async function reconcileSideChannels() {
  if (!cdpHost) return
  let targets
  try {
    const res = await fetch(`http://${cdpHost}:${cdpPort}/json`)
    targets = await res.json()
  } catch {
    return
  }
  if (!Array.isArray(targets)) return
  const matched = targets.filter((t) => t.type === "page" && adapterFor(t.url))
  const liveIds = new Set(matched.map((t) => t.id))
  for (const [id, ws] of sideChannels) {
    if (!liveIds.has(id)) {
      try {
        ws.close()
      } catch (e) {}
      sideChannels.delete(id)
    }
  }
  for (const t of matched) {
    if (!sideChannels.has(t.id)) attachSideChannel(t)
  }
}
setInterval(reconcileSideChannels, 5000)
app.whenReady().then(() => {
  updateBadge() // restore dock badge from persisted unread
  setTimeout(reconcileSideChannels, 1000)
})

ipcMain.handle("cdp:get-notifications", () => notifications)
ipcMain.handle("cdp:mark-notification-read", (_, id) => {
  notifications = markRead(notifications, id)
  saveNotifications()
  updateBadge()
  return notifications
})
ipcMain.handle("cdp:mark-notification-unread", (_, id) => {
  notifications = markUnread(notifications, id)
  saveNotifications()
  updateBadge()
  return notifications
})
ipcMain.handle("cdp:mark-notifications-read", () => {
  notifications = markAllRead(notifications)
  saveNotifications()
  updateBadge()
  return notifications
})
ipcMain.handle("cdp:clear-notifications", () => {
  notifications = []
  saveNotifications()
  updateBadge()
  return notifications
})

// ---------------------------------------------------------------------------
// Local tabs: native WebContentsViews on a shared persistent session, layered
// over the chrome view's viewport hole. The renderer owns the tab list +
// activeKind; the main process owns the views, the session, permissions, and
// extension loading. See docs/adr/0005.
// ---------------------------------------------------------------------------

const LOCAL_PARTITION = "persist:local"
const localSession = () => session.fromPartition(LOCAL_PARTITION)

function setupLocalSession() {
  const ses = localSession()
  const allowMedia = () => settings.autoGrantLocalMedia ?? true
  // Web-layer permissions (mic/camera/notifications/etc.) for local tabs.
  // A media request also triggers the macOS TCC prompt up front.
  ses.setPermissionRequestHandler((_wc, permission, cb) => {
    if (permission === "media") ensureMediaAccess()
    cb(allowMedia())
  })
  ses.setPermissionCheckHandler(() => allowMedia())
  // Screen-share: prefer the macOS system picker; fall back to the first screen.
  ses.setDisplayMediaRequestHandler(
    (_request, cb) => {
      desktopCapturer
        .getSources({ types: ["screen", "window"] })
        .then((sources) => cb(sources[0] ? { video: sources[0] } : {}))
        .catch(() => cb({}))
    },
    { useSystemPicker: true },
  )
  loadLocalExtensions()
}

// Electron implements chrome.storage.local but NOT .sync (it throws "sync is not
// available" in content scripts — electron/electron, electron-browser-shell#34).
// We can't inject into a loaded extension's content-script world, so we load a
// patched COPY whose content scripts get this shim prepended: it aliases
// storage.sync → local and reports local onChanged as "sync" so listeners keyed
// on "sync" still fire. The popup gets the same aliasing via its preload.
const SYNC_SHIM_SRC = `;(() => {
  try {
    const s = chrome.storage
    if (!s || !s.local) return
    try { Object.defineProperty(s, "sync", { value: s.local, configurable: true, writable: true }) } catch (_) {}
    const add = s.onChanged.addListener.bind(s.onChanged)
    s.onChanged.addListener = (cb) => add((changes, area) => cb(changes, area === "local" ? "sync" : area))
  } catch (_) {}
})();`

// srcPath -> loaded Electron.Extension (loaded from a patched copy).
const loadedExt = new Map()

// Copy the extension to userData and prepend the sync shim to its (isolated-world)
// content scripts. Returns the patched copy's path to load.
function prepareExtension(src) {
  const dest = path.join(app.getPath("userData"), "loaded-extensions", path.basename(src))
  try {
    fs.rmSync(dest, { recursive: true, force: true })
  } catch (e) {}
  fs.cpSync(src, dest, { recursive: true })
  try {
    const mpath = path.join(dest, "manifest.json")
    const m = JSON.parse(fs.readFileSync(mpath, "utf8"))
    const shim = "__cdp_sync_shim.js"
    fs.writeFileSync(path.join(dest, shim), SYNC_SHIM_SRC)
    if (Array.isArray(m.content_scripts)) {
      for (const cs of m.content_scripts) {
        // MAIN-world scripts have no chrome.* to patch — only the isolated ones.
        if (cs.world && String(cs.world).toUpperCase() === "MAIN") continue
        cs.js = [shim, ...(cs.js || [])]
      }
      fs.writeFileSync(mpath, JSON.stringify(m, null, 2))
    }
  } catch (e) {
    console.error("ext shim failed:", e.message)
  }
  return dest
}

async function loadOneExtension(src) {
  try {
    const ext = await localSession().extensions.loadExtension(prepareExtension(src), {
      allowFileAccess: true,
    })
    loadedExt.set(src, ext)
    return ext
  } catch (e) {
    console.error("local extension load failed:", src, e.message)
    return null
  }
}

async function loadLocalExtensions() {
  for (const p of settings.localExtensionPaths || []) await loadOneExtension(p)
}

// macOS gates mic/camera behind TCC regardless of the web grant. Trigger the
// system prompt up front so the first meeting works without a silent failure.
async function ensureMediaAccess() {
  if (!(settings.autoGrantLocalMedia ?? true)) return
  if (typeof systemPreferences.askForMediaAccess !== "function") return
  for (const kind of ["microphone", "camera"]) {
    try {
      if (systemPreferences.getMediaAccessStatus(kind) !== "granted") {
        await systemPreferences.askForMediaAccess(kind)
      }
    } catch (e) {}
  }
}

ipcMain.handle("local:get-pins", () => settings.localPins || [])
ipcMain.handle("local:save-pins", (_e, pins) => {
  settings.localPins = pins
  saveSettings(settings)
})

// Validate an unpacked-extension folder before loading. Returns the parsed
// manifest, or an { error } message suitable for a toast.
function readManifest(dir) {
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"))
  } catch {
    return { error: "No readable manifest.json in that folder." }
  }
  if (manifest.manifest_version !== 3) {
    return { error: "Only Manifest V3 extensions are supported." }
  }
  if (!manifest.name) return { error: "manifest.json is missing a name." }
  return { manifest }
}

const ICON_MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", svg: "image/svg+xml" }
function iconDataUrl(dir, manifest) {
  const icons = manifest.icons || {}
  const rel = icons["128"] || icons["48"] || icons["32"] || Object.values(icons)[0]
  if (!rel) return null
  try {
    const buf = fs.readFileSync(path.join(dir, rel))
    const ext = path.extname(rel).slice(1).toLowerCase()
    return `data:${ICON_MIME[ext] || "image/png"};base64,${buf.toString("base64")}`
  } catch {
    return null
  }
}

// Rich, Chrome-like info for each configured extension (loaded or not).
function extensionInfo() {
  return (settings.localExtensionPaths || []).map((p) => {
    const ext = loadedExt.get(p)
    const m = ext ? ext.manifest : (readManifest(p).manifest ?? {})
    const base = ext ? ext.url : ""
    const popup = m.action?.default_popup
    const optionsPage = m.options_page || m.options_ui?.page
    return {
      path: p,
      loaded: !!ext,
      id: ext?.id ?? null,
      name: ext?.name ?? m.name ?? p,
      version: ext?.version ?? m.version ?? "",
      description: m.description ?? "",
      icon: iconDataUrl(p, m),
      popupUrl: popup && base ? base + popup : null,
      optionsUrl: optionsPage && base ? base + optionsPage : null,
    }
  })
}

ipcMain.handle("local:get-extensions", () => extensionInfo())

ipcMain.handle("local:pick-extension", async () => {
  const res = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] })
  if (res.canceled || !res.filePaths[0]) return { extensions: extensionInfo() }
  const p = res.filePaths[0]
  const parsed = readManifest(p)
  if (parsed.error) return { error: parsed.error }
  if (!(await loadOneExtension(p))) {
    return { error: "Failed to load extension." }
  }
  if (!settings.localExtensionPaths) settings.localExtensionPaths = []
  if (!settings.localExtensionPaths.includes(p)) {
    settings.localExtensionPaths.push(p)
    saveSettings(settings)
  }
  return { extensions: extensionInfo() }
})

ipcMain.handle("local:reload-extension", async (_e, p) => {
  try {
    const ex = loadedExt.get(p)
    if (ex) localSession().extensions.removeExtension(ex.id)
    loadedExt.delete(p)
  } catch (e) {}
  if (!(await loadOneExtension(p))) return { error: "Failed to reload extension." }
  return { extensions: extensionInfo() }
})

// Extension action popup, shown as a Chrome-style popover anchored under the
// toolbar icon. A dedicated WebContentsView loads the popup page. Two injected
// fixes run at document-start: (1) alias chrome.storage.sync → local (Electron
// has no `sync`, so the extension's sync.get silently fails → blank toggles);
// (2) close the popover on blur / Escape.
let actionPopupView = null
let actionPopupOpening = false
let actionPopupId = null
let lastClosedId = null
let lastClosedAt = 0

function closeActionPopup() {
  if (!actionPopupView) return
  const v = actionPopupView
  lastClosedId = actionPopupId
  lastClosedAt = Date.now()
  actionPopupView = null
  actionPopupId = null
  try {
    mainWindow.contentView.removeChildView(v)
    v.webContents.close()
  } catch (e) {}
}

ipcMain.handle("local:close-action-popup", () => closeActionPopup())

ipcMain.handle("local:open-action-popup", async (_e, { id, anchor }) => {
  closeActionPopup()
  // Toggle off: re-clicking the same icon. The popup's `blur` from this click
  // already closed it just now, so treat a same-id open within the grace window
  // as a toggle-off and stay closed.
  if (actionPopupOpening) return
  if (id === lastClosedId && Date.now() - lastClosedAt < 350) return
  actionPopupOpening = true

  const ext = extensionInfo().find((e) => e.id === id)
  if (!ext || !ext.popupUrl) {
    actionPopupOpening = false
    return
  }

  const view = new WebContentsView({
    webPreferences: {
      partition: LOCAL_PARTITION,
      // Main-world preload that aliases chrome.storage.sync → local before the
      // popup's scripts run (Electron has no sync; see storage-sync-shim.js).
      preload: path.join(__dirname, "inject", "storage-sync-shim.js"),
      contextIsolation: false,
    },
  })
  view.setBackgroundColor("#00000000")
  actionPopupView = view
  actionPopupId = id
  const wc = view.webContents
  // Dismiss when focus leaves the popup (clicking the page or chrome).
  wc.on("blur", () => closeActionPopup())

  mainWindow.contentView.addChildView(view)
  await wc.loadURL(ext.popupUrl)

  // Size to content, then anchor under the icon (right-aligned), clamped to the window.
  let size = { w: 360, h: 480 }
  try {
    size = await wc.executeJavaScript(
      "({w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight})",
    )
  } catch (e) {}
  actionPopupOpening = false
  // Closed during the async setup — don't resurrect it.
  if (actionPopupView !== view) return
  const { width: winW, height: winH } = mainWindow.getContentBounds()
  const w = Math.min(Math.max(size.w || 360, 280), 440)
  const top = Math.round((anchor?.bottom ?? 44) + 4)
  const h = Math.min(Math.max(size.h || 480, 120), winH - top - 8)
  let x = Math.round((anchor?.right ?? winW) - w)
  x = Math.max(8, Math.min(x, winW - w - 8))
  view.setBounds({ x, y: top, width: w, height: h })
  wc.focus()
})

ipcMain.handle("local:remove-extension", (_e, p) => {
  settings.localExtensionPaths = (settings.localExtensionPaths || []).filter((x) => x !== p)
  saveSettings(settings)
  try {
    const ex = loadedExt.get(p)
    if (ex) localSession().extensions.removeExtension(ex.id)
    loadedExt.delete(p)
  } catch (e) {}
  return { extensions: extensionInfo() }
})

app.on("window-all-closed", () => {
  if (activeWs) {
    clearAdaptiveOverride(activeWs)
    try {
      activeWs.close()
    } catch (e) {}
  }
  for (const ws of sideChannels.values()) {
    try {
      ws.close()
    } catch (e) {}
  }
  app.quit()
})
