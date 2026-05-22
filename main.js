const { app, BrowserWindow, ipcMain, nativeTheme, clipboard } = require('electron')
const path = require('path')
const fs = require('fs')
const WebSocket = require('ws')

let mainWindow
let activeWs = null
let connectId = 0
// Last device-metrics override the renderer applied. Re-sent on every (re)connect
// before the screencast starts so a tab switch lands already sized — no native-size
// first frame and the resulting jiggle. Cleared when the override is cleared.
let cachedMetrics = null

// Settings persistence
const settingsPath = path.join(app.getPath('userData'), 'settings.json')

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
  } catch {
    return { host: 'localhost', port: 9222, themeSource: 'system' }
  }
}

function saveSettings(settings) {
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
}

let settings = loadSettings()
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
    ws.send(JSON.stringify({ id: cmdId++, method: 'Emulation.clearDeviceMetricsOverride', params: {} }))
  } catch (e) {}
}

const isDev = !app.isPackaged && !fs.existsSync(path.join(__dirname, 'dist', 'index.html'))

app.whenReady().then(() => {
  nativeTheme.themeSource = settings.themeSource || 'system'

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 12 },
    vibrancy: 'sidebar',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
  } else {
    mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'))
  }

  // Notify renderer when native theme changes
  nativeTheme.on('updated', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('cdp:native-theme-changed', nativeTheme.shouldUseDarkColors)
    }
  })

  // Trackpad swipe gestures (macOS)
  mainWindow.on('swipe', (_, direction) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('cdp:swipe', direction)
    }
  })
})

ipcMain.handle('cdp:copy-to-clipboard', (_, text) => {
  clipboard.writeText(text)
})

ipcMain.handle('cdp:list-tabs', async () => {
  try {
    const res = await fetch(`http://${cdpHost}:${cdpPort}/json`)
    return await res.json()
  } catch (e) {
    return { error: e.message }
  }
})

ipcMain.handle('cdp:new-tab', async (_, url) => {
  try {
    const res = await fetch(`http://${cdpHost}:${cdpPort}/json/new?${url || 'about:blank'}`, { method: 'PUT' })
    return await res.json()
  } catch (e) {
    return { error: e.message }
  }
})

ipcMain.handle('cdp:close-tab', async (_, tabId) => {
  try {
    await fetch(`http://${cdpHost}:${cdpPort}/json/close/${tabId}`)
    return { ok: true }
  } catch (e) {
    return { error: e.message }
  }
})

ipcMain.handle('cdp:connect', async (_, tabId) => {
  // Close previous
  if (activeWs) {
    const old = activeWs
    activeWs = null
    clearAdaptiveOverride(old)
    try { old.close() } catch(e) {}
  }

  const myId = ++connectId

  try {
    // Activate the tab first
    await fetch(`http://${cdpHost}:${cdpPort}/json/activate/${tabId}`)

    // Small delay for activation
    await new Promise(r => setTimeout(r, 200))

    if (myId !== connectId) return { error: 'cancelled' }

    const res = await fetch(`http://${cdpHost}:${cdpPort}/json`)
    const tabs = await res.json()
    const tab = tabs.find(t => t.id === tabId)
    if (!tab) return { error: 'Tab not found' }

    return new Promise((resolve) => {
      console.log("Connecting to:", tab.webSocketDebuggerUrl)
      const ws = new WebSocket(tab.webSocketDebuggerUrl)

      ws.on('open', () => {
        if (myId !== connectId) { ws.close(); return resolve({ error: 'cancelled' }) }
        activeWs = ws
        resolve({ ok: true })

        const bounds = mainWindow.getBounds()
        ws.send(JSON.stringify({ id: 1, method: 'Page.enable', params: {} }))
        ws.send(JSON.stringify({ id: 2, method: 'Input.enable', params: {} }))
        // Re-apply the cached adaptive override before the screencast so the first
        // frame is already sized to the window — prevents the tab-switch jiggle.
        if (settings.adaptiveViewport && cachedMetrics) {
          ws.send(JSON.stringify({ id: 5, method: 'Emulation.setDeviceMetricsOverride', params: cachedMetrics }))
        }
        ws.send(JSON.stringify({
          id: 3, method: 'Page.startScreencast',
          params: { format: 'jpeg', quality: 80, maxWidth: bounds.width * 2, maxHeight: bounds.height * 2 }
        }))
        // Suppress native context menu (invisible in screencast and blocks interaction)
        ws.send(JSON.stringify({
          id: 4, method: 'Runtime.evaluate',
          params: { expression: "document.addEventListener('contextmenu', e => e.preventDefault(), true)" }
        }))
      })

      ws.on('message', (data) => {
        if (activeWs !== ws) return
        try {
          const msg = JSON.parse(data.toString())
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('cdp:event', msg)
          }
        } catch(e) {}
      })

      ws.on('close', () => {
        if (activeWs === ws) activeWs = null
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('cdp:disconnected')
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
ipcMain.on('cdp:send', (_, method, params) => {
  if (method === 'Emulation.setDeviceMetricsOverride') cachedMetrics = params
  else if (method === 'Emulation.clearDeviceMetricsOverride') cachedMetrics = null
  if (activeWs && activeWs.readyState === WebSocket.OPEN) {
    activeWs.send(JSON.stringify({ id: cmdId++, method, params: params || {} }))
  }
})

ipcMain.handle('cdp:invoke', async (_, method, params) => {
  if (!activeWs || activeWs.readyState !== WebSocket.OPEN) {
    return { error: 'not connected' }
  }
  const id = cmdId++
  return new Promise((resolve) => {
    const handler = (data) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.id === id) {
          activeWs.off('message', handler)
          resolve(msg.result || {})
        }
      } catch(e) {}
    }
    activeWs.on('message', handler)
    activeWs.send(JSON.stringify({ id, method, params: params || {} }))
    setTimeout(() => {
      activeWs?.off('message', handler)
      resolve({ error: 'timeout' })
    }, 3000)
  })
})

ipcMain.handle('cdp:config', () => ({ host: cdpHost, port: cdpPort }))

ipcMain.handle('cdp:test-config', async (_, config) => {
  try {
    const res = await fetch(`http://${config.host}:${config.port}/json/version`, {
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return { error: `HTTP ${res.status}` }
    const info = await res.json()
    return { ok: true, browser: info.Browser || 'Unknown browser' }
  } catch (e) {
    return { error: e.name === 'TimeoutError' ? 'Connection timed out' : e.message }
  }
})

ipcMain.handle('cdp:set-config', (_, config) => {
  cdpHost = config.host
  cdpPort = config.port
  settings.host = config.host
  settings.port = config.port
  saveSettings(settings)
})

ipcMain.handle('cdp:get-sidebar-width', () => settings.sidebarWidth || 220)

ipcMain.handle('cdp:set-sidebar-width', (_, width) => {
  settings.sidebarWidth = width
  saveSettings(settings)
})

ipcMain.handle('cdp:get-ui-state', () => ({
  sidebarCollapsed: settings.sidebarCollapsed ?? false,
  pinnedOpen: settings.pinnedOpen ?? true,
  adaptiveViewport: settings.adaptiveViewport ?? false,
  switchBlur: settings.switchBlur ?? true,
}))

ipcMain.handle('cdp:set-ui-state', (_, partial) => {
  if ('sidebarCollapsed' in partial) settings.sidebarCollapsed = partial.sidebarCollapsed
  if ('pinnedOpen' in partial) settings.pinnedOpen = partial.pinnedOpen
  if ('adaptiveViewport' in partial) settings.adaptiveViewport = partial.adaptiveViewport
  if ('switchBlur' in partial) settings.switchBlur = partial.switchBlur
  saveSettings(settings)
})

// Bookmarks
ipcMain.handle('cdp:get-bookmarks', () => {
  return settings.bookmarks || []
})

ipcMain.handle('cdp:add-bookmark', (_, bookmark) => {
  if (!settings.bookmarks) settings.bookmarks = []
  // Avoid duplicates by URL
  if (!settings.bookmarks.some(b => b.url === bookmark.url)) {
    settings.bookmarks.push(bookmark)
    saveSettings(settings)
  }
  return settings.bookmarks
})

ipcMain.handle('cdp:remove-bookmark', (_, url) => {
  if (!settings.bookmarks) settings.bookmarks = []
  settings.bookmarks = settings.bookmarks.filter(b => b.url !== url)
  saveSettings(settings)
  return settings.bookmarks
})

ipcMain.handle('cdp:reorder-bookmarks', (_, bookmarks) => {
  settings.bookmarks = bookmarks
  saveSettings(settings)
  return settings.bookmarks
})

ipcMain.handle('cdp:set-theme-source', (_, source) => {
  nativeTheme.themeSource = source
  settings.themeSource = source
  saveSettings(settings)
})

ipcMain.handle('cdp:get-theme-source', () => {
  return settings.themeSource || 'system'
})

app.on('window-all-closed', () => {
  if (activeWs) {
    clearAdaptiveOverride(activeWs)
    try { activeWs.close() } catch(e) {}
  }
  app.quit()
})
