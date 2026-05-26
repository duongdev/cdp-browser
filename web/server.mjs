// Web proxy server — the browser-facing backend for the web port, mirroring what
// Electron's main.js does over IPC, but over plain HTTP: POST for commands, SSE
// for server pushes, no WebSocket on the browser hop, no auth (nginx + Authentik
// sit in front, outside this repo). Owns one active CDP screencast socket, the
// notification side-channels, and settings.json. See docs/tasks/007.
//
// Run:  CDP_HOST=<remote-ip> CDP_PORT=9222 PORT=7800 node web/server.mjs

import { createReadStream, existsSync, readFileSync, writeFileSync } from "node:fs"
import http from "node:http"
import { dirname, extname, join, normalize } from "node:path"
import { fileURLToPath } from "node:url"
import WebSocket from "ws"
import endpoints from "../cdp-endpoints.js"
import { ingest, markAllRead, markRead, markUnread, matchAdapter } from "../notifications.js"
import { createSettingsStore } from "../settings-store.js"
import { emulatedMediaParams } from "../theme-emulation.js"

const HERE = dirname(fileURLToPath(import.meta.url))
const DIST = join(HERE, "..", "dist")
const PORT = Number(process.env.PORT || 7800)
const SETTINGS_PATH = process.env.SETTINGS_PATH || join(HERE, "..", "web-settings.json")
const NOTIFS_PATH = process.env.NOTIFS_PATH || join(HERE, "..", "web-notifications.json")
// Browser tab title for the web build, set at deploy time. Electron keeps the
// title baked into index.html (it loads the file directly, not via this server).
const APP_TITLE = process.env.APP_TITLE || "CDP Portal"

// ---- settings -------------------------------------------------------------
const loadJson = (p, fallback) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"))
  } catch {
    return fallback
  }
}
const settings = createSettingsStore({
  initial: loadJson(SETTINGS_PATH, {
    host: process.env.CDP_HOST || "localhost",
    port: Number(process.env.CDP_PORT || 9222),
  }),
  persist: (s) => writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2)),
})
// Env wins on first boot so a fresh deploy points at the right host immediately.
if (process.env.CDP_HOST)
  settings.setConfig({ host: process.env.CDP_HOST, port: Number(process.env.CDP_PORT || 9222) })

const host = () => settings.getConfig().host
const port = () => settings.getConfig().port

// ---- SSE fan-out ----------------------------------------------------------
const sseClients = new Set()
function broadcast(event, payload) {
  const line = `event: ${event}\ndata: ${JSON.stringify(payload ?? {})}\n\n`
  for (const res of sseClients) {
    try {
      res.write(line)
    } catch {
      sseClients.delete(res)
    }
  }
}

// ---- active screencast socket (1 upstream -> N SSE subscribers) ----------
let activeWs = null
let activeTabId = null
let connectId = 0
let cmdId = 100
let cachedMetrics = null
let themeDark = false // renderer drives this via /api/theme (matchMedia)

const wsOpen = (ws) => ws && ws.readyState === WebSocket.OPEN
function rawSend(ws, method, params) {
  if (wsOpen(ws)) ws.send(JSON.stringify({ id: cmdId++, method, params: params || {} }))
}
function applyThemeEmulation(ws) {
  if (!wsOpen(ws)) return
  rawSend(
    ws,
    "Emulation.setEmulatedMedia",
    emulatedMediaParams(settings.getUiState().syncTheme, themeDark),
  )
}
function clearAdaptiveOverride(ws) {
  if (settings.getUiState().adaptiveViewport && wsOpen(ws))
    rawSend(ws, "Emulation.clearDeviceMetricsOverride", {})
}

async function fetchJson(desc) {
  const res = await fetch(desc.url, { method: desc.method })
  return res.json()
}

async function connect(tabId) {
  if (activeWs) {
    const old = activeWs
    activeWs = null
    clearAdaptiveOverride(old)
    try {
      old.close()
    } catch {}
  }
  const myId = ++connectId
  activeTabId = tabId
  try {
    await fetch(endpoints.activate(host(), port(), tabId).url)
    // Give the remote browser time to promote the tab before we list its WS URL.
    await new Promise((r) => setTimeout(r, 200))
    if (myId !== connectId) return { error: "cancelled" }
    const tabs = await fetchJson(endpoints.list(host(), port()))
    const tab = tabs.find((t) => t.id === tabId)
    if (!tab) return { error: "Tab not found" }

    return await new Promise((resolve) => {
      const ws = new WebSocket(tab.webSocketDebuggerUrl)
      ws.on("open", () => {
        if (myId !== connectId) {
          ws.close()
          return resolve({ error: "cancelled" })
        }
        activeWs = ws
        resolve({ ok: true })
        rawSend(ws, "Page.enable")
        rawSend(ws, "Input.enable")
        applyThemeEmulation(ws)
        const ui = settings.getUiState()
        if (ui.adaptiveViewport && cachedMetrics) {
          rawSend(ws, "Emulation.setDeviceMetricsOverride", cachedMetrics)
        } else if (!ui.adaptiveViewport) {
          // Release any override a prior crash left pinned (take ownership, then clear).
          rawSend(ws, "Emulation.setDeviceMetricsOverride", {
            width: 1400,
            height: 900,
            deviceScaleFactor: 1,
            mobile: false,
          })
          rawSend(ws, "Emulation.clearDeviceMetricsOverride", {})
        }
        rawSend(ws, "Page.startScreencast", {
          format: "jpeg",
          quality: 80,
          maxWidth: 3000,
          maxHeight: 2000,
        })
        rawSend(ws, "Runtime.evaluate", {
          expression: "document.addEventListener('contextmenu',e=>e.preventDefault(),true)",
        })
      })
      ws.on("message", (data) => {
        if (activeWs !== ws) return
        try {
          const msg = JSON.parse(data.toString())
          // Ack frames here (not from the browser) — a per-frame HTTP POST round-trip
          // would throttle the stream and add latency. See docs/tasks/006.
          if (msg.method === "Page.screencastFrame")
            rawSend(ws, "Page.screencastFrameAck", { sessionId: msg.params.sessionId })
          broadcast("cdp", msg)
        } catch {}
      })
      ws.on("close", () => {
        if (activeWs === ws) activeWs = null
        broadcast("disconnected", {})
      })
      ws.on("error", (e) => {
        if (activeWs === ws) activeWs = null
        resolve({ error: e.message })
      })
    })
  } catch (e) {
    return { error: e.message }
  }
}

function invoke(method, params) {
  const ws = activeWs
  if (!wsOpen(ws)) return Promise.resolve({ error: "not connected" })
  const id = cmdId++
  return new Promise((resolve) => {
    const handler = (data) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.id === id) {
          ws.off("message", handler)
          resolve(msg.result || {})
        }
      } catch {}
    }
    ws.on("message", handler)
    ws.send(JSON.stringify({ id, method, params: params || {} }))
    setTimeout(() => {
      ws.off("message", handler)
      resolve({ error: "timeout" })
    }, 3000)
  })
}

function send(method, params) {
  if (method === "Emulation.setDeviceMetricsOverride") cachedMetrics = params
  else if (method === "Emulation.clearDeviceMetricsOverride") cachedMetrics = null
  rawSend(activeWs, method, params)
}

// A coalesced batch of raw CDP commands from the web transport (input + acks).
// The renderer (remote-page) already translated InputIntent → Input.dispatch*; we
// just relay each command to the active socket in order.
function applyBatch(items) {
  for (const c of items || []) if (c && c.method) send(c.method, c.params)
}

// ---- notification side-channels (port of main.js, sans OS toast) ----------
const NOTIFY_BINDING = "__cdpNotify"
const injectSrc = (f) => readFileSync(join(HERE, "..", "inject", f), "utf8")
const ADAPTERS = [
  {
    name: "teams",
    match: (h) => /(^|\.)teams\.(microsoft|cloud\.microsoft)\.com$/.test(h),
    source: injectSrc("teams-notify.js"),
    iconUrl:
      "https://statics.teams.cdn.office.net/evergreen-assets/icons/microsoft_teams_logo_refresh.ico",
  },
  {
    name: "outlook",
    match: (h) => /(^|\.)outlook\.(office\.com|live\.com|cloud\.microsoft)$/.test(h),
    source: injectSrc("outlook-notify.js"),
    iconUrl: "https://outlook.office365.com/owa/favicon.ico",
  },
]
const adapterFor = (url) => matchAdapter(url, ADAPTERS)
const NOTIF_CAP = 50
let notifications = loadJson(NOTIFS_PATH, [])
const saveNotifs = () => {
  try {
    writeFileSync(NOTIFS_PATH, JSON.stringify(notifications))
  } catch (e) {
    console.error("[web] saveNotifs failed:", e.message)
  }
}
const sideChannels = new Map()

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
  if (!entry) return
  notifications = list
  saveNotifs()
  broadcast("notification", entry)
}

function attachSideChannel(target) {
  const adapter = adapterFor(target.url)
  if (!adapter || !target.webSocketDebuggerUrl) return
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  sideChannels.set(target.id, ws)
  ws.on("open", () => {
    rawSend(ws, "Runtime.enable")
    rawSend(ws, "Page.enable")
    ws.send(
      JSON.stringify({
        id: cmdId++,
        method: "Runtime.addBinding",
        params: { name: NOTIFY_BINDING },
      }),
    )
    rawSend(ws, "Page.addScriptToEvaluateOnNewDocument", { source: adapter.source })
    rawSend(ws, "Runtime.evaluate", { expression: adapter.source })
  })
  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString())
      if (msg.method === "Runtime.bindingCalled" && msg.params.name === NOTIFY_BINDING)
        ingestNotification(msg.params.payload, target.id, target.url)
    } catch {}
  })
  const drop = () => sideChannels.get(target.id) === ws && sideChannels.delete(target.id)
  ws.on("close", drop)
  ws.on("error", drop)
}

async function reconcileSideChannels() {
  let targets
  try {
    targets = await fetchJson(endpoints.list(host(), port()))
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
      } catch {}
      sideChannels.delete(id)
    }
  }
  for (const t of matched) if (!sideChannels.has(t.id)) attachSideChannel(t)
}
setInterval(reconcileSideChannels, 5000)
setTimeout(reconcileSideChannels, 1000)

// ---- HTTP routing ---------------------------------------------------------
const BODY_LIMIT = 1024 * 1024 // 1 MB — guards against memory exhaustion; CDP payloads are tiny
const body = (req) =>
  new Promise((resolve, reject) => {
    let b = ""
    req.on("data", (c) => {
      b += c
      if (b.length > BODY_LIMIT) {
        req.destroy()
        reject(new Error("request body too large"))
      }
    })
    req.on("end", () => {
      try {
        resolve(b ? JSON.parse(b) : {})
      } catch {
        resolve({})
      }
    })
  })
const json = (res, data, code = 200) =>
  res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(data ?? null))

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".ico": "image/x-icon",
}

function serveStatic(req, res, pathname) {
  const rel = normalize(pathname).replace(/^(\.\.[/\\])+/, "")
  let file = join(DIST, rel === "/" ? "index.html" : rel)
  if (!existsSync(file) || !file.startsWith(DIST)) file = join(DIST, "index.html") // SPA fallback
  if (!existsSync(file)) return res.writeHead(404).end("build the renderer: pnpm build")
  // index.html is rewritten in-flight to apply the deploy-time title; other assets stream.
  if (file.endsWith("index.html")) {
    const html = readFileSync(file, "utf8").replace(
      /<title>.*?<\/title>/,
      `<title>${APP_TITLE}</title>`,
    )
    return res.writeHead(200, { "Content-Type": "text/html" }).end(html)
  }
  res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" })
  createReadStream(file).pipe(res)
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x")
  const p = url.pathname
  const POST = req.method === "POST"

  if (p === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    })
    res.write("retry: 2000\n\n")
    sseClients.add(res)
    req.on("close", () => sseClients.delete(res))
    return
  }

  try {
    // transport
    if (p === "/api/invoke" && POST) {
      const { method, params } = await body(req)
      return json(res, await invoke(method, params))
    }
    if (p === "/api/send" && POST) {
      const { method, params } = await body(req)
      send(method, params)
      return res.writeHead(204).end()
    }
    if (p === "/api/cdp-batch" && POST) {
      applyBatch((await body(req)).items)
      return res.writeHead(204).end()
    }
    // tabs
    if (p === "/api/tabs" && !POST)
      return json(res, await fetchJson(endpoints.list(host(), port())))
    if (p === "/api/tabs/new" && POST)
      return json(res, await fetchJson(endpoints.newTab(host(), port(), (await body(req)).url)))
    if (p === "/api/tabs/close" && POST) {
      await fetch(endpoints.close(host(), port(), (await body(req)).id).url)
      return json(res, { ok: true })
    }
    if (p === "/api/connect" && POST) return json(res, await connect((await body(req)).id))
    // config
    if (p === "/api/config" && !POST) return json(res, settings.getConfig())
    if (p === "/api/config" && POST) {
      settings.setConfig(await body(req))
      return json(res, settings.getConfig())
    }
    if (p === "/api/config/test" && POST) {
      const { host: h, port: pt } = await body(req)
      try {
        const r = await fetch(endpoints.version(h, pt).url, { signal: AbortSignal.timeout(5000) })
        if (!r.ok) return json(res, { error: `HTTP ${r.status}` })
        const info = await r.json()
        return json(res, { ok: true, browser: info.Browser || "Unknown browser" })
      } catch (e) {
        return json(res, { error: e.name === "TimeoutError" ? "Connection timed out" : e.message })
      }
    }
    // ui-state / sidebar / theme
    if (p === "/api/sidebar-width" && !POST) return json(res, settings.getSidebarWidth())
    if (p === "/api/sidebar-width" && POST) {
      settings.setSidebarWidth((await body(req)).width)
      return res.writeHead(204).end()
    }
    if (p === "/api/ui-state" && !POST) return json(res, settings.getUiState())
    if (p === "/api/ui-state" && POST) {
      const before = settings.getUiState().syncTheme
      settings.setUiState(await body(req))
      if (settings.getUiState().syncTheme !== before) applyThemeEmulation(activeWs)
      return res.writeHead(204).end()
    }
    if (p === "/api/theme-source" && !POST) return json(res, settings.getThemeSource())
    if (p === "/api/theme-source" && POST) {
      settings.setThemeSource((await body(req)).source)
      return res.writeHead(204).end()
    }
    if (p === "/api/theme" && POST) {
      themeDark = !!(await body(req)).isDark
      applyThemeEmulation(activeWs)
      return res.writeHead(204).end()
    }
    // pins
    if (p === "/api/pins" && !POST) return json(res, settings.getPins())
    if (p === "/api/pins/add" && POST) return json(res, settings.addPin(await body(req)))
    if (p === "/api/pins/update" && POST) {
      const { id, patch } = await body(req)
      return json(res, settings.updatePin(id, patch))
    }
    if (p === "/api/pins/remove" && POST) return json(res, settings.removePin((await body(req)).id))
    if (p === "/api/pins/reorder" && POST)
      return json(res, settings.reorderPins((await body(req)).pins))
    // notifications
    if (p === "/api/notifications" && !POST) return json(res, notifications)
    if (p === "/api/notifications/mark-read" && POST) {
      notifications = markRead(notifications, (await body(req)).id)
      saveNotifs()
      return json(res, notifications)
    }
    if (p === "/api/notifications/mark-unread" && POST) {
      notifications = markUnread(notifications, (await body(req)).id)
      saveNotifs()
      return json(res, notifications)
    }
    if (p === "/api/notifications/mark-all-read" && POST) {
      notifications = markAllRead(notifications)
      saveNotifs()
      return json(res, notifications)
    }
    if (p === "/api/notifications/clear" && POST) {
      notifications = []
      saveNotifs()
      return json(res, notifications)
    }
  } catch (e) {
    return json(res, { error: e.message }, 500)
  }

  if (p.startsWith("/api/")) return res.writeHead(404).end("unknown api route")
  return serveStatic(req, res, p)
})

server.listen(PORT, "0.0.0.0", () =>
  console.log(`[web] http://0.0.0.0:${PORT}  ->  cdp ${host()}:${port()}`),
)
