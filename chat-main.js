// Standalone Teams Chat app — a thin Electron shell that loads the web build's
// /chat surface from a running server. All Teams data + notifications come from
// that server (ADR-0019); this shell only supplies a native window, dock
// presence, and OS notifications (the renderer's Notification API bridges to
// macOS automatically, fired foreground by chat-app.tsx when unfocused).
//
// It is a separate app from the CDP Browser (`main.js`): distinct appId, own
// build config (electron-builder.chat.json), installed side-by-side by
// scripts/install-local.sh. A self-contained Electron chat backend (its own CDP
// keeper + Teams creds) is a deferred fast-follow — today the shell points at a
// web build that owns that.
const { app, BrowserWindow, shell, nativeTheme } = require("electron")
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
// Precedence: CHAT_SERVER_URL env > stored config > localhost dev default.
const SERVER_URL = resolveServerUrl(
  process.env.CHAT_SERVER_URL,
  config.serverUrl,
  "http://localhost:7800",
)
const CHAT_URL = `${SERVER_URL}/chat/`

let win

function createWindow() {
  const bounds = config.bounds || {}
  win = new BrowserWindow({
    width: bounds.width || 1040,
    height: bounds.height || 760,
    x: bounds.x,
    y: bounds.y,
    minWidth: 380,
    minHeight: 480,
    title: "Teams Chat",
    titleBarStyle: "hiddenInset",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0a0a0a" : "#ffffff",
    webPreferences: { contextIsolation: true },
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

app.whenReady().then(() => {
  createWindow()
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})
