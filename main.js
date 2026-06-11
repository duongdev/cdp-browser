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
const path = require("node:path")
const fs = require("node:fs")
const WebSocket = require("ws")
const { emulatedMediaParams } = require("./core/theme-emulation")
const { createSettingsStore } = require("./core/settings-store")
const endpoints = require("./core/cdp-endpoints")
const { tierToParams, DEFAULT_TIER } = require("./core/quality-tier")

// The window is a BaseWindow composed of a chrome view (the React UI, full
// window) layered over zero-or-more local-tab page views. `chromeView` hosts
// everything the renderer draws — including the CDP screencast canvas — so all
// `webContents.send`/`isFocused` that used to target the BrowserWindow now go
// through the chrome view. See docs/adr/0005.
let mainWindow
let chromeView
const chromeWc = () => chromeView?.webContents
function chromeSend(channel, ...args) {
  const wc = chromeWc()
  if (wc && !wc.isDestroyed()) wc.send(channel, ...args)
}
let activeWs = null
let activeTabId = null
let connectId = 0
// Last device-metrics override the renderer applied. Re-sent on a (re)connect that
// actually changes it (before the screencast starts) so a tab switch lands already
// sized — no native-size first frame and the resulting jiggle. The override is bound
// to the target and survives the socket swap, so an unchanged re-issue is a no-op
// resize that visibly bounces the viewport — we skip it by comparing against
// `appliedMetrics`. Cleared when the override is cleared.
let cachedMetrics = null
let appliedMetrics = null
// Adaptive-OFF release dance (take-ownership + clear of any crash-pinned override)
// runs at most once per process; after that the remote stays native and a switch
// sends neither override nor clear (no bounce).
let releasedPinnedOverride = false

// Shallow value-compare for the small flat device-metrics object — used to skip
// re-issuing identical metrics across a switch.
const sameMetrics = (a, b) => {
  if (a === b) return true
  if (!a || !b) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  return ka.length === kb.length && ka.every((k) => a[k] === b[k])
}

// Settings persistence. The schema, defaults, and legacy migrations live in the
// shared settings-store core; main.js injects only the fs write and reads the
// initial parsed file. Electron-only keys the store doesn't model (localPins,
// localExtensionPaths, …) live on the same persisted object — read/written via
// `settings` (the store's live object) and the same `persist` writer.
const settingsPath = path.join(app.getPath("userData"), "settings.json")

function readSettingsFile() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath, "utf8"))
  } catch {
    return { host: "localhost", port: 9222, themeSource: "system" }
  }
}

const persist = (s) => fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2))

const initialSettings = readSettingsFile()
const hadLegacyKeys =
  initialSettings.switchBlur !== undefined || initialSettings.bookmarks !== undefined

const settingsStore = createSettingsStore({ initial: initialSettings, persist })
// Live settings object owned by the store; direct reads/writes for unmodeled keys.
const settings = settingsStore.raw()
const saveSettings = () => persist(settings)

// Re-persist the migrated shape once on first load when a legacy key was present.
if (hadLegacyKeys) saveSettings()

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
    // Released to native — the next connect must re-apply the cached override.
    appliedMetrics = null
  } catch {}
}

// Push the app's resolved light/dark scheme to the remote page so sites (and extensions)
// that read `prefers-color-scheme` follow the shell theme. Pure mapping in theme-emulation.js.
function applyThemeEmulation(ws) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  const params = emulatedMediaParams(settings.syncTheme ?? true, nativeTheme.shouldUseDarkColors)
  try {
    ws.send(JSON.stringify({ id: cmdId++, method: "Emulation.setEmulatedMedia", params }))
  } catch {}
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

ipcMain.handle("cdp:read-clipboard", () => {
  return clipboard.readText()
})

ipcMain.handle("cdp:read-clipboard-image", () => {
  const img = clipboard.readImage()
  return img.isEmpty() ? null : img.toDataURL()
})

ipcMain.handle("cdp:list-tabs", async () => {
  try {
    const { url, method } = endpoints.list(cdpHost, cdpPort)
    const res = await fetch(url, { method })
    return await res.json()
  } catch (e) {
    return { error: e.message }
  }
})

ipcMain.handle("cdp:new-tab", async (_, url) => {
  try {
    const req = endpoints.newTab(cdpHost, cdpPort, url)
    const res = await fetch(req.url, { method: req.method })
    return await res.json()
  } catch (e) {
    return { error: e.message }
  }
})

ipcMain.handle("cdp:close-tab", async (_, tabId) => {
  try {
    const { url, method } = endpoints.close(cdpHost, cdpPort, tabId)
    await fetch(url, { method })
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
    // Switch teardown: we are connecting to a *different* target, so reset
    // appliedMetrics — the new target has no prior override. The override is NOT
    // cleared on the old socket (it's a different target and doesn't matter).
    // Mark this teardown host-initiated so its close handler stays silent — switching
    // tabs must not announce a disconnect. Only a close we did NOT trigger (a real drop)
    // reaches the renderer as cdp:disconnected.
    appliedMetrics = null
    old.__intentional = true
    try {
      old.close()
    } catch {}
  }

  const myId = ++connectId
  activeTabId = tabId

  try {
    // Activate the tab first
    const act = endpoints.activate(cdpHost, cdpPort, tabId)
    await fetch(act.url, { method: act.method })

    // Small delay for activation
    await new Promise((r) => setTimeout(r, 200))

    if (myId !== connectId) return { error: "cancelled" }

    const listReq = endpoints.list(cdpHost, cdpPort)
    const res = await fetch(listReq.url, { method: listReq.method })
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
        // frame is already sized to the window — prevents the tab-switch jiggle. The
        // override survives the socket swap, so skip an unchanged re-issue (a no-op
        // resize that would itself bounce the viewport).
        if (settings.adaptiveViewport && cachedMetrics) {
          if (!sameMetrics(cachedMetrics, appliedMetrics)) {
            ws.send(
              JSON.stringify({
                id: 5,
                method: "Emulation.setDeviceMetricsOverride",
                params: cachedMetrics,
              }),
            )
            appliedMetrics = cachedMetrics
          }
        } else if (!settings.adaptiveViewport && !releasedPinnedOverride) {
          // Adaptive is off: release any device-metrics override a prior crash left
          // pinned on the host. A clean quit clears it; a force-kill can't. A bare clear
          // is a no-op on an override owned by the now-dead session, so first re-assert
          // one (taking ownership in this session), then clear it — releasing to native.
          // Latched to run at most once per process — after the first release the remote
          // stays native, so a switch sends neither override nor clear (no bounce).
          releasedPinnedOverride = true
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
        // Quality-latency tier (t055): Electron has no picker, so it uses the default
        // tier (balanced ⇒ quality 80 / everyNthFrame 2, today's behavior). The numbers
        // come from quality-tier.js so this path can't drift from the connector's.
        const tier = tierToParams(DEFAULT_TIER)
        ws.send(
          JSON.stringify({
            id: 3,
            method: "Page.startScreencast",
            params: {
              format: "jpeg",
              quality: tier.jpegQuality,
              maxWidth: bounds.width * 2,
              maxHeight: bounds.height * 2,
              everyNthFrame: tier.everyNthFrame,
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
        } catch {}
      })

      ws.on("close", () => {
        if (activeWs === ws) activeWs = null
        // A host-initiated teardown (tab switch) already detached the surface — stay
        // silent. Only an unexpected close (real drop) surfaces cdp:disconnected.
        if (!ws.__intentional) chromeSend("cdp:disconnected")
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
  if (method === "Emulation.setDeviceMetricsOverride") {
    cachedMetrics = params
    // appliedMetrics records what the remote ACTUALLY received, so it's stamped below
    // only when the send goes out on an open socket. If we're mid-reconnect (activeWs
    // null during the backoff window), the remote never gets these metrics — recording
    // them as applied would make the next same-target reconnect wrongly skip the re-issue
    // (sameMetrics(cached, applied)===true) and leave the page native-size → letterbox.
  } else if (method === "Emulation.clearDeviceMetricsOverride") {
    cachedMetrics = null
    appliedMetrics = null
  }
  if (activeWs && activeWs.readyState === WebSocket.OPEN) {
    if (method === "Emulation.setDeviceMetricsOverride") appliedMetrics = params
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
      } catch {}
    }
    activeWs.on("message", handler)
    activeWs.send(JSON.stringify({ id, method, params: params || {} }))
    setTimeout(() => {
      activeWs?.off("message", handler)
      resolve({ error: "timeout" })
    }, 3000)
  })
})

ipcMain.handle("cdp:config", () => settingsStore.getConfig())

ipcMain.handle("cdp:test-config", async (_, config) => {
  try {
    const { url, method } = endpoints.version(config.host, config.port)
    const res = await fetch(url, { method, signal: AbortSignal.timeout(5000) })
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
  settingsStore.setConfig({ host: config.host, port: config.port })
})

ipcMain.handle("cdp:get-sidebar-width", () => settingsStore.getSidebarWidth())

ipcMain.handle("cdp:set-sidebar-width", (_, width) => settingsStore.setSidebarWidth(width))

ipcMain.handle("cdp:get-ui-state", () => settingsStore.getUiState())

ipcMain.handle("cdp:set-ui-state", (_, partial) => {
  settingsStore.setUiState(partial)
  // Theme emulation tracks the syncTheme toggle; re-apply on the live socket.
  if ("syncTheme" in partial) applyThemeEmulation(activeWs)
})

// Pins (live-tab holders). The renderer owns link state (`targetId`); main is the
// persistent store. `reorder-pins` replaces the whole array, so it also persists
// link/unlink changes. Dedup-by-url and persistence live in the shared store.
ipcMain.handle("cdp:get-pins", () => settingsStore.getPins())
ipcMain.handle("cdp:add-pin", (_, pin) => settingsStore.addPin(pin))
ipcMain.handle("cdp:update-pin", (_, id, patch) => settingsStore.updatePin(id, patch))
ipcMain.handle("cdp:remove-pin", (_, id) => settingsStore.removePin(id))
ipcMain.handle("cdp:reorder-pins", (_, pins) => settingsStore.reorderPins(pins))

ipcMain.handle("cdp:set-theme-source", (_, source) => {
  nativeTheme.themeSource = source
  settingsStore.setThemeSource(source)
})

ipcMain.handle("cdp:get-theme-source", () => settingsStore.getThemeSource())

// ---------------------------------------------------------------------------
// Notifications: per-target read-only side-channels capture each site's in-app
// toast (independent of the active-tab screencast socket). See docs/adr/0003.
// ---------------------------------------------------------------------------

// The whole side-channel lifecycle + store lives in the shared core; main.js
// injects only Electron effects (capture-script reads, /json target list, the
// persisted store file, the OS Notification + dock badge gated by shouldNotifyOs).
const { shouldNotifyOs } = require("./core/notifications")
const { createNotificationCenter } = require("./core/notifications-sidechain")

// Persisted store (separate from settings.json to keep that file lean).
const notificationsPath = path.join(app.getPath("userData"), "notifications.json")
const readNotifications = () => {
  try {
    return JSON.parse(fs.readFileSync(notificationsPath, "utf8"))
  } catch {
    return []
  }
}
function saveNotifications(list) {
  try {
    fs.writeFileSync(notificationsPath, JSON.stringify(list))
  } catch {}
}

// Dock badge mirrors total unread (macOS). 0 clears it.
function updateBadge() {
  if (typeof app.setBadgeCount === "function") app.setBadgeCount(notificationCenter.unreadCount())
}

// Retain shown Notification objects: Electron/V8 garbage-collects a Notification with no
// live reference, and the collected object never delivers its `click` event — the banner
// shows but clicking it does nothing. Held until the user clicks or it closes.
const liveNotifications = new Set()
const notificationCenter = createNotificationCenter({
  readInject: (name) => fs.readFileSync(path.join(__dirname, "inject", name), "utf8"),
  listTargets: async () => {
    if (!cdpHost) return []
    const { url, method } = endpoints.list(cdpHost, cdpPort)
    const res = await fetch(url, { method })
    return res.json()
  },
  load: readNotifications,
  save: saveNotifications,
  now: Date.now,
  WebSocketCtor: WebSocket,
  onEntry: (entry) => {
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
      liveNotifications.add(osN)
      const cleanupN = () => liveNotifications.delete(osN)
      osN.on("click", () => {
        cleanupN()
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show()
          mainWindow.focus()
          chromeSend("cdp:notification-activate", entry)
        }
      })
      osN.on("close", cleanupN)
      osN.show()
    }
  },
})

setInterval(() => notificationCenter.reconcile(), 5000)
app.whenReady().then(() => {
  updateBadge() // restore dock badge from persisted unread
  setTimeout(() => notificationCenter.reconcile(), 1000)
})

ipcMain.handle("cdp:get-notifications", () => notificationCenter.list())
ipcMain.handle("cdp:mark-notification-read", (_, id) => {
  const list = notificationCenter.markRead(id)
  updateBadge()
  return list
})
ipcMain.handle("cdp:mark-notification-unread", (_, id) => {
  const list = notificationCenter.markUnread(id)
  updateBadge()
  return list
})
ipcMain.handle("cdp:mark-notifications-read", () => {
  const list = notificationCenter.markAllRead()
  updateBadge()
  return list
})
ipcMain.handle("cdp:clear-notifications", () => {
  const list = notificationCenter.clear()
  updateBadge()
  return list
})
ipcMain.handle("cdp:remove-notifications", (_, ids) => {
  const list = notificationCenter.removeMany(ids)
  updateBadge()
  return list
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
  } catch {}
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
    } catch {}
  }
}

ipcMain.handle("local:get-pins", () => settings.localPins || [])
ipcMain.handle("local:save-pins", (_e, pins) => {
  settings.localPins = pins
  saveSettings()
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
    saveSettings()
  }
  return { extensions: extensionInfo() }
})

ipcMain.handle("local:reload-extension", async (_e, p) => {
  try {
    const ex = loadedExt.get(p)
    if (ex) localSession().extensions.removeExtension(ex.id)
    loadedExt.delete(p)
  } catch {}
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
  } catch {}
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
  if (!ext?.popupUrl) {
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
  } catch {}
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
  saveSettings()
  try {
    const ex = loadedExt.get(p)
    if (ex) localSession().extensions.removeExtension(ex.id)
    loadedExt.delete(p)
  } catch {}
  return { extensions: extensionInfo() }
})

app.on("window-all-closed", () => {
  if (activeWs) {
    clearAdaptiveOverride(activeWs)
    try {
      activeWs.close()
    } catch {}
  }
  notificationCenter.close()
  app.quit()
})
