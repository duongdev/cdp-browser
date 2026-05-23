const { app, BrowserWindow, ipcMain, nativeTheme, clipboard, Notification, Menu } =
  require("electron")
const path = require("path")
const fs = require("fs")
const WebSocket = require("ws")
const { emulatedMediaParams } = require("./theme-emulation")

let mainWindow
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

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 12, y: 12 },
    vibrancy: "sidebar",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (isDev) {
    mainWindow.loadURL("http://localhost:5173")
  } else {
    mainWindow.loadFile(path.join(__dirname, "dist", "index.html"))
  }

  // Notify renderer when native theme changes
  nativeTheme.on("updated", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("cdp:native-theme-changed", nativeTheme.shouldUseDarkColors)
    }
    applyThemeEmulation(activeWs)
  })

  // Trackpad swipe gestures (macOS)
  mainWindow.on("swipe", (_, direction) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("cdp:swipe", direction)
    }
  })
})

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
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("cdp:event", msg)
          }
        } catch (e) {}
      })

      ws.on("close", () => {
        if (activeWs === ws) activeWs = null
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("cdp:disconnected")
        }
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
  saveSettings(settings)
})

// Bookmarks
ipcMain.handle("cdp:get-bookmarks", () => {
  return settings.bookmarks || []
})

ipcMain.handle("cdp:add-bookmark", (_, bookmark) => {
  if (!settings.bookmarks) settings.bookmarks = []
  // Avoid duplicates by URL
  if (!settings.bookmarks.some((b) => b.url === bookmark.url)) {
    settings.bookmarks.push(bookmark)
    saveSettings(settings)
  }
  return settings.bookmarks
})

ipcMain.handle("cdp:remove-bookmark", (_, url) => {
  if (!settings.bookmarks) settings.bookmarks = []
  settings.bookmarks = settings.bookmarks.filter((b) => b.url !== url)
  saveSettings(settings)
  return settings.bookmarks
})

ipcMain.handle("cdp:reorder-bookmarks", (_, bookmarks) => {
  settings.bookmarks = bookmarks
  saveSettings(settings)
  return settings.bookmarks
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
  markAllRead,
  unreadCount,
} = require("./notifications")
const NOTIFY_BINDING = "__cdpNotify"
const injectSource = fs.readFileSync(path.join(__dirname, "inject", "teams-notify.js"), "utf8")
const ADAPTERS = [
  {
    name: "teams",
    match: (h) => /(^|\.)teams\.(microsoft|cloud\.microsoft)\.com$/.test(h),
    source: injectSource,
    iconUrl:
      "https://statics.teams.cdn.office.net/evergreen-assets/icons/microsoft_teams_logo_refresh.ico",
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

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("cdp:notification", entry)
  }

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
        mainWindow.webContents.send("cdp:notification-activate", entry)
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
