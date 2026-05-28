// Web proxy server — the browser-facing backend for the web port, mirroring what
// Electron's main.js does over IPC, but over plain HTTP: POST for commands, SSE
// for server pushes, no WebSocket on the browser hop, no auth (nginx + Authentik
// sit in front, outside this repo). Owns one active CDP screencast socket, the
// notification side-channels, and settings.json. See docs/tasks/007.
//
// Run:  CDP_HOST=<remote-ip> CDP_PORT=9222 PORT=7800 node web/server.mjs

import nodeCrypto from "node:crypto"
import { createReadStream, existsSync, readFileSync, writeFileSync } from "node:fs"
import http from "node:http"
import { dirname, extname, join, normalize } from "node:path"
import { fileURLToPath } from "node:url"
import webpush from "web-push"
import WebSocket, { WebSocketServer } from "ws"
import endpoints from "../cdp-endpoints.js"
import { deriveKey, open, seal } from "../crypto-envelope.js"
import { createLineSplitter } from "../line-splitter.js"
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

// Optional E2E: with E2E_PASSPHRASE set, every /api body + SSE frame is sealed with a
// PBKDF2/AES-GCM key a TLS-intercepting proxy never has. The salt is public (served via
// /api/crypto-params); set E2E_SALT for a stable key across restarts (else per-boot, and
// clients re-derive on reload). See t012 / ADR-0006.
const E2E_PASSPHRASE = process.env.E2E_PASSPHRASE || ""
const E2E_ITERS = Number(process.env.E2E_ITERS || 600000)
const E2E_SALT = process.env.E2E_SALT || nodeCrypto.randomBytes(16).toString("base64")
const e2eKey = E2E_PASSPHRASE ? deriveKey(E2E_PASSPHRASE, E2E_SALT, E2E_ITERS) : null
if (e2eKey) console.log("[web] E2E encryption ON")

// VAPID config for Web Push (iOS 16.4+ PWA installed mode). Keys can be supplied via
// env (recommended for stable subscriptions across restarts) or generated per-boot
// (clients then re-subscribe). The subject is just a contact URL/mailto for push
// services to reach out about delivery issues.
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:admin@example.com"
const VAPID_PUBLIC_KEY =
  process.env.VAPID_PUBLIC_KEY ||
  "BDIDtkQnVIAwcjjpgXgUSKLj6DGvZx_E9UMe4vzn1S-ih2rTIlZMGU_unzeBfIW6VSG_6bF8gUqMvMJUuHeZyzo"
const VAPID_PRIVATE_KEY =
  process.env.VAPID_PRIVATE_KEY || "RR3uJMq4at7Eim0GvvRFxhZZHEeRK8sYmR5XcodvMDQ"
webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY)

// Push subscriptions are persisted next to web-settings.json — in-memory would lose
// them on every server restart, forcing users to re-subscribe. Each subscription has
// the endpoint URL + auth/p256dh keys the browser registered with its push service.
const SUBS_PATH = process.env.SUBS_PATH || join(HERE, "..", "web-push-subs.json")
let pushSubs = []

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

// Load persisted push subscriptions; treat invalid/missing as empty.
pushSubs = loadJson(SUBS_PATH, [])
const savePushSubs = () => {
  try {
    writeFileSync(SUBS_PATH, JSON.stringify(pushSubs, null, 2))
  } catch (e) {
    console.error("[web] savePushSubs failed:", e.message)
  }
}

// Send a push payload to every registered subscription. Subscriptions that come
// back 404/410 (gone) are pruned so we don't keep retrying dead endpoints.
async function sendPushToAll(payload) {
  if (pushSubs.length === 0) return
  const data = JSON.stringify(payload)
  const dead = []
  await Promise.all(
    pushSubs.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, data)
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) dead.push(sub.endpoint)
        else console.error("[web] push failed:", e.statusCode, e.body || e.message)
      }
    }),
  )
  if (dead.length > 0) {
    pushSubs = pushSubs.filter((s) => !dead.includes(s.endpoint))
    savePushSubs()
  }
}

const host = () => settings.getConfig().host
const port = () => settings.getConfig().port

// ---- SSE fan-out ----------------------------------------------------------
const sseClients = new Set()
const wsClients = new Set() // WebSocket subscribers — receive same events SSE clients do (t019)
// Binary WS path for screencast frames (t019, fast path). Sends a small JSON envelope
// describing the frame metadata, then the raw JPEG bytes as a binary WS message
// immediately after — clients pair them by order. Skips base64 encoding (33% bandwidth)
// and the renderer's JSON.parse of a 250KB envelope (main-thread cost). E2E mode keeps
// the legacy sealed JSON path because the binary payload would need its own seal.
function broadcastFrameBinary(params) {
  const { data, ...meta } = params
  const bytes = Buffer.from(data, "base64")
  broadcastFrameBinaryRaw(bytes, meta)
}
function broadcastFrameBinaryRaw(bytes, meta) {
  const envelope = JSON.stringify({
    t: "event",
    event: "cdp-frame",
    data: { method: "Page.screencastFrame", params: meta },
  })
  for (const ws of wsClients) {
    try {
      ws.send(envelope)
      ws.send(bytes)
    } catch {
      wsClients.delete(ws)
    }
  }
}

// Fast-extract from a raw CDP Buffer — avoids `JSON.parse(data.toString())` on a 200KB+
// message every frame, the biggest server-side per-frame cost at CSS-pixel resolutions ≥
// 1280×720. CDP orders params alphabetically (data, metadata, sessionId), so each tag is
// searched from the start of the buffer independently. Returns null if anything looks
// wrong — caller falls back to the safe JSON.parse path. See t019.
const FAST_PROBE_LEN = 64
const METHOD_TAG = Buffer.from('"method":"Page.screencastFrame"', "utf8")
const SID_TAG = Buffer.from('"sessionId":', "utf8")
const DATA_TAG = Buffer.from('"data":"', "utf8")
const META_TAG = Buffer.from('"metadata":', "utf8")
function extractScreencastFast(buf) {
  const methodPos = buf.indexOf(METHOD_TAG, 0)
  if (methodPos === -1 || methodPos >= FAST_PROBE_LEN) return null
  const dataTagPos = buf.indexOf(DATA_TAG, 0)
  if (dataTagPos === -1) return null
  const dataStart = dataTagPos + DATA_TAG.length
  const dataEnd = buf.indexOf(0x22, dataStart) // base64 has no quotes/escapes
  if (dataEnd === -1) return null
  const bytes = Buffer.from(buf.subarray(dataStart, dataEnd).toString("ascii"), "base64")
  const sidTagPos = buf.indexOf(SID_TAG, 0)
  if (sidTagPos === -1) return null
  const sidStart = sidTagPos + SID_TAG.length
  let sidEnd = sidStart
  while (sidEnd < buf.length && buf[sidEnd] >= 0x30 && buf[sidEnd] <= 0x39) sidEnd++
  if (sidEnd === sidStart) return null
  const sessionId = Number(buf.subarray(sidStart, sidEnd).toString("ascii"))
  const metaTagPos = buf.indexOf(META_TAG, 0)
  let metadata
  if (metaTagPos !== -1) {
    let i = metaTagPos + META_TAG.length
    while (i < buf.length && (buf[i] === 0x20 || buf[i] === 0x09)) i++
    if (buf[i] === 0x7b) {
      const objStart = i
      let depth = 0
      do {
        if (buf[i] === 0x7b) depth++
        else if (buf[i] === 0x7d) depth--
        i++
      } while (i < buf.length && depth > 0)
      try {
        metadata = JSON.parse(buf.subarray(objStart, i).toString("utf8"))
      } catch {
        return null
      }
    }
  }
  return { sessionId, bytes, metadata }
}
function broadcastSseOnly(event, payload) {
  // Hot-path optimization: SSE typically has 0 clients once WS is established (clients
  // close SSE on WS-ready). Skip the expensive JSON.stringify(200KB-base64) when nobody's
  // listening — that stringify was eating ~5ms per screencast frame at 25 fps for no gain.
  if (sseClients.size === 0) return
  const data = e2eKey ? seal(payload ?? {}, e2eKey) : JSON.stringify(payload ?? {})
  const line = `event: ${event}\ndata: ${data}\n\n`
  for (const res of sseClients) {
    try {
      res.write(line)
    } catch {
      sseClients.delete(res)
    }
  }
}
function broadcast(event, payload) {
  // Event names stay plaintext (client routing); only the data payload is sealed.
  const data = e2eKey ? seal(payload ?? {}, e2eKey) : JSON.stringify(payload ?? {})
  // SSE: event-stream format. WS: { t, event, data } envelope so the client demuxes the
  // same event names without a separate channel per type.
  const sseLine = `event: ${event}\ndata: ${data}\n\n`
  const wsLine = JSON.stringify({ t: "event", event, data })
  for (const ws of wsClients) {
    try {
      ws.send(wsLine)
    } catch {
      wsClients.delete(ws)
    }
  }
  for (const res of sseClients) {
    try {
      res.write(sseLine)
    } catch {
      sseClients.delete(res)
    }
  }
}

// ---- active screencast socket (1 upstream -> N SSE subscribers) ----------
let activeWs = null
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
        // Fastest path: skip `data.toString()` + JSON.parse on the 200KB envelope when the
        // message is a Page.screencastFrame, we have only WS subscribers (no SSE need for
        // the full JSON), and E2E is off. We extract sessionId + JPEG bytes + metadata
        // straight from the raw Buffer — saves the bulk of per-frame server CPU.
        if (wsClients.size > 0 && !e2eKey && sseClients.size === 0) {
          const fast = extractScreencastFast(data)
          if (fast) {
            rawSend(ws, "Page.screencastFrameAck", { sessionId: fast.sessionId })
            broadcastFrameBinaryRaw(fast.bytes, {
              sessionId: fast.sessionId,
              metadata: fast.metadata,
            })
            return
          }
        }
        try {
          const msg = JSON.parse(data.toString())
          // Ack frames here (not from the browser) — a per-frame HTTP POST round-trip
          // would throttle the stream and add latency. See docs/tasks/006.
          if (msg.method === "Page.screencastFrame") {
            rawSend(ws, "Page.screencastFrameAck", { sessionId: msg.params.sessionId })
            // Fast path for WS subscribers: send the JPEG bytes as a **binary** WS frame
            // (no base64, no JSON.parse of a 250KB string on the renderer thread). SSE
            // subscribers keep the legacy JSON-with-base64 path. See t019 + ADR-0007.
            // E2E gates the binary path: under E2E the data needs sealing; defer that and
            // keep the sealed JSON path so the security model stays intact.
            if (wsClients.size > 0 && !e2eKey) {
              broadcastFrameBinary(msg.params)
              broadcastSseOnly("cdp", msg)
              return
            }
          }
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
  // Fire-and-forget push to all subscribers; backgrounded PWAs only get the event
  // when delivered via Web Push (the SSE broadcast is foreground-only on iOS).
  sendPushToAll({
    id: entry.id,
    title: entry.title,
    body: entry.body,
    targetId: entry.targetId,
    targetUrl: entry.targetUrl,
    targetEntity: entry.targetEntity,
    icon: entry.icon,
    ts: entry.ts,
  })
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
        if (!b) return resolve({})
        resolve(e2eKey ? open(b.trim(), e2eKey) : JSON.parse(b))
      } catch {
        resolve({})
      }
    })
  })
const json = (res, data, code = 200) =>
  res
    .writeHead(code, { "Content-Type": e2eKey ? "text/plain" : "application/json" })
    .end(e2eKey ? seal(data ?? null, e2eKey) : JSON.stringify(data ?? null))

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
  if (file.endsWith("manifest.webmanifest")) {
    const m = readFileSync(file, "utf8").replaceAll("__APP_TITLE__", APP_TITLE)
    return res.writeHead(200, { "Content-Type": "application/manifest+json" }).end(m)
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

  // E2E bootstrap — always plaintext (the client needs it before it has a key). The
  // verifier is a sealed known marker the client decrypts to confirm the passphrase.
  if (p === "/api/crypto-params") {
    return res.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        e2e: !!e2eKey,
        salt: E2E_SALT,
        iterations: E2E_ITERS,
        verifier: e2eKey ? seal({ m: "cdp-e2e-ok" }, e2eKey) : null,
      }),
    )
  }

  // Streaming input channel: one long-lived POST whose request body is a stream of
  // NDJSON frames (a coalesced batch or a single {method,params} per line). Avoids a
  // separate HTTP request per input flush — the low-latency path. The renderer falls
  // back to /api/cdp-batch if this can't be established (e.g. a buffering proxy). See t011.
  if (p === "/api/input-stream" && POST) {
    res.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-cache" })
    const split = createLineSplitter()
    req.on("data", (chunk) => {
      for (const line of split.push(chunk.toString())) {
        try {
          const frame = e2eKey ? open(line, e2eKey) : JSON.parse(line)
          // A probe confirms the body actually streams through (not buffered by a proxy);
          // echo it over SSE so the client switches real input onto the stream.
          if (frame.probe) broadcast("stream-ack", {})
          else applyBatch(frame.items || [frame])
        } catch {}
      }
    })
    req.on("end", () => res.end("ok"))
    req.on("error", () => {})
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
    // Web Push subscriptions — PWA-installed iOS 16.4+. The public key is non-secret;
    // the client uses it as `applicationServerKey` for pushManager.subscribe.
    if (p === "/api/notifications/vapid-public-key" && !POST) {
      return json(res, { key: VAPID_PUBLIC_KEY })
    }
    if (p === "/api/notifications/subscribe" && POST) {
      const sub = await body(req)
      if (!sub || !sub.endpoint) return json(res, { error: "missing endpoint" }, 400)
      // Dedupe by endpoint URL so re-subscribing on the same device replaces in place.
      pushSubs = pushSubs.filter((s) => s.endpoint !== sub.endpoint)
      pushSubs.push(sub)
      savePushSubs()
      return json(res, { ok: true })
    }
    if (p === "/api/notifications/unsubscribe" && POST) {
      const { endpoint } = await body(req)
      if (!endpoint) return json(res, { error: "missing endpoint" }, 400)
      pushSubs = pushSubs.filter((s) => s.endpoint !== endpoint)
      savePushSubs()
      return json(res, { ok: true })
    }
  } catch (e) {
    return json(res, { error: e.message }, 500)
  }

  if (p.startsWith("/api/")) return res.writeHead(404).end("unknown api route")
  return serveStatic(req, res, p)
})

// The streaming input channel is a request body that never completes; Node's default
// 5-min requestTimeout would kill it. Disable it (this server sits behind auth).
server.requestTimeout = 0

// Full-duplex WS transport — same CdpBridge contract as SSE+POST but in one socket
// (t019). Messages: { t: "send"|"invoke"|"invoke-result"|"event", id?, method?, params? }.
// CDP events fan in via broadcast() (added to wsClients above); requests fan out via
// the existing invoke()/send() helpers, so the WS path is a thin envelope layer.
const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 })
// Pass-through WS tunnel to a CDP target (t019, fastest path). Bypasses the server's
// JSON.parse/JSON.stringify per frame and the 1→N broadcast loop — bytes flow CDP↔client
// raw. Bandwidth is the network's ceiling, not the proxy's. The browser can't hit the
// CDP host directly because (a) HTTPS PWAs can't open ws:// (mixed content) and (b)
// Chrome/Edge reject /json WS handshakes carrying Origin without --remote-allow-origins.
// This tunnel keeps TLS on the browser hop while removing the proxy's per-frame cost.
const tunnelWss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 })
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://localhost")
  if (url.pathname.startsWith("/api/cdp-ws/")) {
    const tabId = url.pathname.slice("/api/cdp-ws/".length)
    if (!/^[A-F0-9]{32}$/i.test(tabId)) {
      socket.destroy()
      return
    }
    const cdpUrl = `ws://${host()}:${port()}/devtools/page/${tabId}`
    let upstream
    try {
      upstream = new WebSocket(cdpUrl, { maxPayload: 16 * 1024 * 1024 })
    } catch {
      socket.destroy()
      return
    }
    // Buffer upstream→client messages until handleUpgrade resolves. Critical: if upstream
    // opens before handleUpgrade fires (race on LAN with fast CDP host), we'd miss the
    // open event. Wire listeners on upstream synchronously here so nothing is lost.
    let client = null
    const upstreamToClientBuffer = []
    let upstreamOpen = false
    upstream.on("open", () => {
      upstreamOpen = true
    })
    upstream.on("message", (data, isBinary) => {
      if (client && client.readyState === 1) {
        try {
          client.send(data, { binary: isBinary })
        } catch {}
      } else {
        upstreamToClientBuffer.push({ data, isBinary })
      }
    })
    upstream.on("close", () => {
      try {
        client?.close()
      } catch {}
    })
    upstream.on("error", () => {
      try {
        client?.close()
      } catch {}
    })
    tunnelWss.handleUpgrade(req, socket, head, (c) => {
      client = c
      // Replay any messages that arrived before the client was ready.
      for (const { data, isBinary } of upstreamToClientBuffer) {
        try {
          c.send(data, { binary: isBinary })
        } catch {}
      }
      upstreamToClientBuffer.length = 0
      const clientToUpstreamQueue = []
      c.on("message", (data, isBinary) => {
        if (!upstreamOpen) {
          clientToUpstreamQueue.push({ data, isBinary })
          return
        }
        try {
          upstream.send(data, { binary: isBinary })
        } catch {}
      })
      // Flush queued client→upstream messages once upstream opens.
      if (!upstreamOpen) {
        upstream.once("open", () => {
          for (const { data, isBinary } of clientToUpstreamQueue) {
            try {
              upstream.send(data, { binary: isBinary })
            } catch {}
          }
          clientToUpstreamQueue.length = 0
        })
      }
      c.on("close", () => {
        try {
          upstream.close()
        } catch {}
      })
      c.on("error", () => {
        try {
          upstream.close()
        } catch {}
      })
    })
    return
  }
  if (url.pathname !== "/api/ws") {
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wsClients.add(ws)
    ws.send(JSON.stringify({ t: "ready" }))
    ws.on("message", async (raw) => {
      let parsed
      try {
        const text = raw.toString()
        const body = e2eKey ? await open(text, e2eKey) : JSON.parse(text)
        parsed = body
      } catch (err) {
        console.error("[ws] bad message:", err.message)
        return
      }
      const { t, id, method, params } = parsed || {}
      if (t === "invoke") {
        const result = await invoke(method, params)
        // Envelope plaintext (routing); result sealed under E2E to keep CDP RPC payloads
        // opaque to a TLS-intercepting proxy, matching the SSE+POST guarantee.
        const sealedResult = e2eKey ? await seal(result, e2eKey) : result
        try {
          ws.send(JSON.stringify({ t: "invoke-result", id, result: sealedResult }))
        } catch {}
      } else if (t === "send") {
        // Page.screencastFrameAck is server-acked already; ignore client retries here.
        if (method !== "Page.screencastFrameAck") send(method, params)
      } else if (t === "batch") {
        // Same shape as /api/cdp-batch: { items: [{ method, params }, …] }
        applyBatch(parsed.items)
      }
    })
    ws.on("close", () => wsClients.delete(ws))
    ws.on("error", () => wsClients.delete(ws))
  })
})

server.listen(PORT, "0.0.0.0", () =>
  console.log(`[web] http://0.0.0.0:${PORT}  ->  cdp ${host()}:${port()}`),
)
