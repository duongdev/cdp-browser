// Standalone "CDP Chats" app — a thin Electron shell that loads the web build's
// /chat surface from a running server. All Teams data comes from that server
// (ADR-0019); this shell supplies a native window, dock presence, and OS
// notifications fired from the main process (same mechanism as the CDP Browser
// app — see the `chat:notify` / `chat:set-badge` handlers below), driven by the
// renderer over the chat-preload.js bridge.
//
// It is a separate app from the CDP Browser (`main.js`): distinct appId, own
// build config (electron-builder.chat.json), installed side-by-side by
// scripts/install-local.sh. A self-contained Electron chat backend (its own CDP
// keeper + Teams creds) is a deferred fast-follow — today the shell points at a
// web build that owns that.
const { app, BrowserWindow, Notification, ipcMain, shell, nativeTheme } = require("electron")
const path = require("node:path")
const fs = require("node:fs")
const { resolveServerUrl, isExternalUrl } = require("./core/chat-shell")

const CONFIG_PATH = path.join(app.getPath("userData"), "chat-config.json")

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"))
  } catch {
    return {}
  }
}

function writeConfig(patch) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...readConfig(), ...patch }, null, 2))
  } catch {
    // best-effort — a read-only home dir shouldn't crash the app
  }
}

const config = readConfig()
// Precedence: CHAT_SERVER_URL env > stored config > prod tailnet default. Mutable so the in-app
// Settings server field can repoint the shell without a relaunch.
let serverUrl = resolveServerUrl(
  process.env.CHAT_SERVER_URL,
  config.serverUrl,
  "https://portal.dp.dustin.one",
)
// Restore the last-open conversation on launch (the renderer reports its SPA path via chat:route).
const lastPath =
  typeof config.lastPath === "string" && config.lastPath.startsWith("/chat")
    ? config.lastPath
    : "/chat/"

let win

// Retain shown Notification objects: Electron/V8 garbage-collects a Notification with no
// live reference and the collected object never delivers its `click` event (same guard as
// main.js). Held until the user clicks or it closes.
const liveNotifications = new Set()

function createWindow() {
  const bounds = config.bounds || {}
  win = new BrowserWindow({
    width: bounds.width || 1040,
    height: bounds.height || 760,
    x: bounds.x,
    y: bounds.y,
    minWidth: 380,
    minHeight: 480,
    title: "CDP Chats",
    titleBarStyle: "hiddenInset",
    // Center the traffic lights within the 48px (h-12) header strip.
    trafficLightPosition: { x: 19, y: 17 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0a0a0a" : "#ffffff",
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, "chat-preload.js"),
    },
  })
  win.loadURL(`${serverUrl}${lastPath}`)

  // Non-chat targets (external links, target=_blank) open in the OS browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: "deny" }
  })
  win.webContents.on("will-navigate", (e, url) => {
    if (isExternalUrl(url, serverUrl)) {
      e.preventDefault()
      shell.openExternal(url)
    }
  })

  const saveBounds = () => {
    if (win && !win.isDestroyed()) writeConfig({ bounds: win.getBounds() })
  }
  win.on("resize", saveBounds)
  win.on("move", saveBounds)
}

// Renderer → main notification bridge (chat-preload.js). Mirrors main.js: a held
// Notification whose click shows/focuses the window and posts the convId back so the
// renderer opens that conversation.
ipcMain.on("chat:notify", (_e, { title, body, convId } = {}) => {
  if (!Notification.isSupported()) return
  const n = new Notification({ title: title || "CDP Chats", body: body || "" })
  liveNotifications.add(n)
  const cleanup = () => liveNotifications.delete(n)
  n.on("click", () => {
    cleanup()
    if (win && !win.isDestroyed()) {
      win.show()
      win.focus()
      win.webContents.send("chat:notification-activate", convId)
    }
  })
  n.on("close", cleanup)
  n.show()
})

// Dock badge mirrors the unread count (0 clears it). macOS.
ipcMain.on("chat:set-badge", (_e, count) => {
  if (typeof app.setBadgeCount === "function") app.setBadgeCount(Number(count) || 0)
})

// Reload = force-fetch a fresh build. The chat PWA registers a cache-first service worker, so an
// HTTP-cache-bypassing reload alone still serves the SW's cached bundle; a native always-online
// shell wants the newest build, so we unregister the SW + drop its caches first, then reload
// ignoring cache. The SW re-registers on the next load against an empty cache (fresh assets).
ipcMain.on("chat:reload", async () => {
  const wc = win?.webContents
  if (!wc) return
  try {
    await wc.executeJavaScript(
      `(async()=>{try{const rs=await navigator.serviceWorker.getRegistrations();for(const r of rs)await r.unregister();if(self.caches){for(const k of await caches.keys())await caches.delete(k)}}catch{}})()`,
    )
  } catch {
    // best-effort — reload regardless
  }
  wc.reloadIgnoringCache()
})

// In-app server URL (Settings). Repoints the shell + persists; ignores a non-http(s) value.
ipcMain.handle("chat:get-server-url", () => serverUrl)
ipcMain.on("chat:set-server-url", (_e, url) => {
  const clean = resolveServerUrl(url, null, "")
  if (!/^https?:\/\//.test(clean) || clean === serverUrl) return
  serverUrl = clean
  writeConfig({ serverUrl: clean })
  win?.loadURL(`${serverUrl}/chat/`)
})

// Remember the last-open conversation path so the next launch reopens it.
ipcMain.on("chat:route", (_e, routePath) => {
  if (typeof routePath === "string" && routePath.startsWith("/chat"))
    writeConfig({ lastPath: routePath })
})

app.whenReady().then(() => {
  createWindow()
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})
