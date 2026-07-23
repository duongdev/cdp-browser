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
// Precedence: CHAT_SERVER_URL env > stored config > prod tailnet default.
const SERVER_URL = resolveServerUrl(
  process.env.CHAT_SERVER_URL,
  config.serverUrl,
  "https://portal.dp.dustin.one",
)
const CHAT_URL = `${SERVER_URL}/chat/`

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
  win.loadURL(CHAT_URL)

  // Non-chat targets (external links, target=_blank) open in the OS browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: "deny" }
  })
  win.webContents.on("will-navigate", (e, url) => {
    if (isExternalUrl(url, SERVER_URL)) {
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

// Browser-style nav (Electron-only header controls). Back/forward walk the page history; reload
// bypasses the HTTP cache so it force-fetches a fresh build.
ipcMain.on("chat:go-back", () => {
  const nav = win?.webContents?.navigationHistory
  if (nav?.canGoBack()) nav.goBack()
})
ipcMain.on("chat:go-forward", () => {
  const nav = win?.webContents?.navigationHistory
  if (nav?.canGoForward()) nav.goForward()
})
ipcMain.on("chat:reload", () => win?.webContents?.reloadIgnoringCache())

app.whenReady().then(() => {
  createWindow()
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})
