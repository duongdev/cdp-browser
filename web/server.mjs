// Web proxy server — the browser-facing backend for the web port, mirroring what
// Electron's main.js does over IPC, but over plain HTTP: POST for commands, SSE
// for server pushes, no WebSocket on the browser hop, no auth (nginx + Authentik
// sit in front, outside this repo). Owns one active CDP screencast socket, the
// notification side-channels, and settings.json. See docs/tasks/007.
//
// Run:  CDP_HOST=<remote-ip> CDP_PORT=9222 PORT=7800 node web/server.mjs

import { execFileSync } from "node:child_process"
import nodeCrypto from "node:crypto"
import { createReadStream, existsSync, readFileSync, writeFileSync } from "node:fs"
import http from "node:http"
import { dirname, extname, join, normalize } from "node:path"
import { fileURLToPath } from "node:url"
import webpush from "web-push"
import WebSocket, { WebSocketServer } from "ws"
import endpoints from "../core/cdp-endpoints.js"
import { deriveKey, open, seal } from "../core/crypto-envelope.js"
import { createAckGate } from "../core/frame-ack-gate.js"
import { createFrameThrottle } from "../core/frame-throttle.js"
import { createLineSplitter } from "../core/line-splitter.js"
import { buildHealth, shouldAlert } from "../core/notification-health.js"
import sidechain from "../core/notifications-sidechain.js"
import connector from "../core/remote-page-connector.js"
import { createSettingsStore } from "../core/settings-store.js"
import { createSlackApi } from "../core/slack-api.js"
import { buildSlackGroups } from "../core/slack-creds.js"
import { createSlackSweeper } from "../core/slack-sweep-runner.js"
import {
  liveTeamIds as slackLiveTeamIds,
  planParkedTabs as slackPlanParkedTabs,
  teamIdOf as slackTeamIdOf,
  upsertWorkspace as slackUpsertWorkspace,
} from "../core/slack-workspaces.js"

const HERE = dirname(fileURLToPath(import.meta.url))
const DIST = join(HERE, "..", "dist")
const PORT = Number(process.env.PORT || 7800)
const SETTINGS_PATH = process.env.SETTINGS_PATH || join(HERE, "..", "web-settings.json")
const NOTIFS_PATH = process.env.NOTIFS_PATH || join(HERE, "..", "web-notifications.json")
// Slack workspace registry (t070) — non-secret metadata only (teamId → {url,name,lastSeen}).
// Drives the parked-tab keeper so a closed/lost Slack tab is recreated. No creds on disk:
// the shared d cookie + all-team localConfig re-extract from any live Slack tab.
const SLACK_WORKSPACES_PATH =
  process.env.SLACK_WORKSPACES_PATH || join(HERE, "..", "slack-workspaces.json")
// Browser tab title for the web build, set at deploy time. Electron keeps the
// title baked into index.html (it loads the file directly, not via this server).
const APP_TITLE = process.env.APP_TITLE || "CDP Portal"

// Build identity, set at deploy time (mirrors APP_TITLE). GIT_SHA comes from the
// build pipeline (Dockerfile ARG / deploy env) since the server can't see the Vite
// define; the version defaults to the co-located package.json. Surfaced via /api/version.
const APP_VERSION =
  process.env.APP_VERSION ||
  JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8")).version
// The build pipeline doesn't always set GIT_SHA (the redeploy script ships none), which
// stranded /api/version at "unknown" and broke the PWA's version-poll update check (t045).
// The server runs from a git checkout, so fall back to the deployed HEAD short sha,
// resolved once at boot. Keep "unknown" if git is unavailable (e.g. a tarball deploy).
function resolveGitSha() {
  if (process.env.GIT_SHA) return process.env.GIT_SHA
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: join(HERE, ".."),
      encoding: "utf8",
    }).trim()
  } catch {
    return "unknown"
  }
}
const GIT_SHA = resolveGitSha()

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
// back 404/410 (gone) are pruned so we don't keep retrying dead endpoints. Transient
// failures are retried once before giving up (t066).
// Web Push payloads are capped (~4KB after encryption). The full entry can blow past that —
// Teams' `targetEntity` is a multi-KB object and a Slack body can carry long URLs — which the
// push service rejects with 413 PayloadTooLarge, dropping the notification entirely. Trim to
// what the SW actually needs: drop `targetEntity` (the store keeps it for in-app clicks; the
// phone deep-routes via `activate` + the conversation key) and cap the body.
const PUSH_BODY_CAP = 240
function trimPushPayload(payload) {
  const { targetEntity: _drop, body, ...rest } = payload
  const trimmed = body && body.length > PUSH_BODY_CAP ? `${body.slice(0, PUSH_BODY_CAP)}…` : body
  return { ...rest, body: trimmed }
}

async function sendPushToAll(payload) {
  if (pushSubs.length === 0) return
  const data = JSON.stringify(trimPushPayload(payload))
  const dead = []
  await Promise.all(
    pushSubs.map(async (sub) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await webpush.sendNotification(sub, data)
          return // success
        } catch (e) {
          if (e.statusCode === 404 || e.statusCode === 410) {
            dead.push(sub.endpoint)
            return // permanent, don't retry
          }
          // transient error — retry once
          if (attempt === 1) {
            console.error("[web] push failed (after retry):", e.statusCode, e.body || e.message)
          }
        }
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
// WS clients that announced ack-after-paint support (t056): they ack each Screencast
// Frame only after painting it, so the server defers its own remote-ack and gates the
// next frame on their paint-ack — at most one frame in flight on the link instead of an
// unbounded stale-frame backlog. A client opts in by sending `{ t: "frame-ack-mode" }`
// after the ready handshake; absence keeps the legacy server-self-ack behavior (SSE-only
// clients and older WS clients are unaffected).
const paintAckClients = new Set()
// True while ≥1 supporting client is connected — the only condition under which the
// server defers its self-ack to the client's paint-ack. With zero supporting clients
// (SSE-only, e2e harness, old clients) the server self-acks eagerly as before.
const paintAckActive = () => paintAckClients.size > 0
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
  // Stamp the server send time so the client can compute frame age (t057). It is the
  // server wall clock; the client's RTT-derived one-way offset corrects the skew. The
  // fast extract path comes through here with no stamp; the slow path pre-stamps `meta`.
  const envelope = JSON.stringify({
    t: "event",
    event: "cdp-frame",
    data: {
      method: "Page.screencastFrame",
      params: { ...meta, serverTs: meta.serverTs ?? Date.now() },
    },
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
// The connect/disconnect choreography + the single-socket invariant (ADR-0001), the
// connectId race-guard, and the cached-metrics-before-startScreencast re-apply
// (ADR-0002) all live in the backend-agnostic connector (remote-page-connector.js).
// This file injects its effects (WebSocket factory, activate builder, target list,
// settings) and fans out the raw CDP messages it emits — frame ack, broadcast, and
// the binary fast path stay here, tied to this server's SSE/WS subscriber machinery.
let themeDark = false // renderer drives this via /api/theme (matchMedia)

async function fetchJson(desc) {
  const res = await fetch(desc.url, { method: desc.method })
  return res.json()
}

const { createRemotePageConnector, SCREENCAST_TARGET_FPS } = connector
// Relay-side fresh-frame-wins throttle (t054): ack every frame so the remote keeps
// producing, but only broadcast at the target rate so a slow link drains the freshest
// frame instead of a backlog of stale ones. The rate ceiling lives in the connector.
const frameThrottle = createFrameThrottle({ targetFps: SCREENCAST_TARGET_FPS })

// One-frame-in-flight gate for the ack-after-paint path (t056). While a supporting client
// is connected, the server defers its remote-ack until the client paints + acks the
// outstanding frame, so at most one Screencast Frame is in flight on the link instead of a
// growing backlog. With no supporting client the gate is bypassed and the server self-acks
// eagerly (the t054 throttle then governs the broadcast rate). Coalesce-to-latest: a frame
// arriving while one is outstanding is dropped (never queued) so the freshest always wins.
const frameAckGate = createAckGate()
// Stranded-paint watchdog: if a supporting client never acks (decode error, tab hidden, a
// connection drop that didn't surface as a close), free the slot and ack the remote anyway
// so a single lost paint can't wedge the stream forever. Generous vs. the frame interval so
// a healthy slow link is never tripped; the ack arriving first cancels it.
const PAINT_ACK_WATCHDOG_MS = 1000
let paintAckWatchdog = null
function clearPaintAckWatchdog() {
  if (paintAckWatchdog !== null) {
    clearTimeout(paintAckWatchdog)
    paintAckWatchdog = null
  }
}
// Decide a Screencast Frame's ack timing. Returns whether to broadcast it now.
//   - paint-ack mode active + free slot → forward, mark outstanding, defer the remote-ack
//     to the client's paint-ack (arm the watchdog).
//   - paint-ack mode active + slot busy → drop (the client hasn't caught up; coalesce).
//   - no supporting client → self-ack immediately, honor the t054 broadcast throttle.
function admitFrame(sessionId) {
  if (!paintAckActive()) {
    remotePage.ackFrame(sessionId)
    return frameThrottle.shouldEmit()
  }
  if (!frameAckGate.mayProceed()) return false
  frameAckGate.markSent(sessionId)
  clearPaintAckWatchdog()
  paintAckWatchdog = setTimeout(() => {
    const stranded = frameAckGate.outstanding()
    frameAckGate.reset()
    paintAckWatchdog = null
    if (stranded !== null) remotePage.ackFrame(stranded) // release the remote despite no paint
  }, PAINT_ACK_WATCHDOG_MS)
  return true
}
// A supporting client painted + acked the outstanding frame: clear the slot, cancel the
// watchdog, and ack the remote so the next frame flows. Any-client ack releases the slot
// (one client is the daily-driver case; the fastest client's ack frees it for the rest).
function onClientPaintAck(sessionId) {
  if (frameAckGate.outstanding() === null) return
  frameAckGate.ackReceived(sessionId)
  if (frameAckGate.outstanding() === null) {
    clearPaintAckWatchdog()
    remotePage.ackFrame(sessionId)
  }
}
// Free the slot when the in-flight assumptions change — a remote close, or the last
// supporting client leaving — so a stale pending ack never blocks the next stream.
function resetPaintAckGate() {
  clearPaintAckWatchdog()
  frameAckGate.reset()
}

const remotePage = createRemotePageConnector({
  transport: (wsUrl) => new WebSocket(wsUrl),
  endpoints: { activate: (h, p, id) => endpoints.activate(h, p, id) },
  config: () => settings.getConfig(),
  uiState: () => settings.getUiState(),
  themeDark: () => themeDark,
  activate: (desc) => fetch(desc.url, { method: desc.method }),
  listTargets: () => fetchJson(endpoints.list(host(), port())),
})

// Host fan-out of every raw CDP message from the active Remote Page socket. The
// connector guards staleness (only the active socket reaches us); we own the frame
// ack + the binary/SSE broadcast split. Frames are acked via the connector so the
// ack rides the connector-owned socket and id counter.
remotePage.onEvent((data) => {
  // Fastest path: skip `data.toString()` + JSON.parse on the 200KB envelope when the
  // message is a Page.screencastFrame, we have only WS subscribers (no SSE need for
  // the full JSON), and E2E is off. We extract sessionId + JPEG bytes + metadata
  // straight from the raw Buffer — saves the bulk of per-frame server CPU.
  if (wsClients.size > 0 && !e2eKey && sseClients.size === 0) {
    const fast = extractScreencastFast(data)
    if (fast) {
      // admitFrame owns the ack timing: self-ack + throttle when no supporting client,
      // or defer the ack to the client's paint-ack and gate the next frame to one in
      // flight when one is connected (t056). It returns whether to broadcast this frame.
      if (admitFrame(fast.sessionId))
        broadcastFrameBinaryRaw(fast.bytes, { sessionId: fast.sessionId, metadata: fast.metadata })
      return
    }
  }
  try {
    const msg = JSON.parse(data.toString())
    // Ack frames here (not from the browser) — a per-frame HTTP POST round-trip
    // would throttle the stream and add latency. See docs/tasks/006.
    if (msg.method === "Page.screencastFrame") {
      // admitFrame owns the ack timing (t056): self-ack + t054 throttle when no supporting
      // client; defer to the client's paint-ack and cap to one in flight when one exists.
      if (!admitFrame(msg.params.sessionId)) return
      // Server send timestamp for client-side frame age (t057). Stamped on the relayed
      // params so it rides whichever path carries this frame (binary WS, SSE, or sealed).
      msg.params.serverTs = Date.now()
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
remotePage.onClose(() => {
  // A remote drop strands any frame awaiting a paint-ack — free the slot so the next
  // connect's first frame is immediately eligible (no wedge from a pending ack). (t056)
  resetPaintAckGate()
  broadcast("disconnected", {})
})

const connect = (tabId) => remotePage.connect({ tabId })
const invoke = (method, params) => remotePage.invoke(method, params)
const send = (method, params) => remotePage.send(method, params)
const applyThemeEmulation = () => remotePage.applyTheme()

// A coalesced batch of raw CDP commands from the web transport (input + acks).
// The renderer (remote-page) already translated InputIntent → Input.dispatch*; we
// just relay each command to the active socket in order.
function applyBatch(items) {
  for (const c of items || []) if (c?.method) send(c.method, c.params)
}

// ---- notification side-channel (shared core, headless) --------------------
// The whole lifecycle + store lives in notifications-sidechain.js; the server
// injects only its effects (capture-script reads, /json target list, the
// persisted store file, the in-band broadcast + Web Push). It runs headless on
// the server lifecycle, so capture + persistence + push fire with no client
// connected; the in-band broadcast simply reaches no one until a client attaches.
const { createNotificationCenter } = sidechain
const notificationCenter = createNotificationCenter({
  readInject: (f) => readFileSync(join(HERE, "..", "inject", f), "utf8"),
  listTargets: () => fetchJson(endpoints.list(host(), port())),
  load: () => loadJson(NOTIFS_PATH, []),
  save: (list) => {
    try {
      writeFileSync(NOTIFS_PATH, JSON.stringify(list))
    } catch (e) {
      console.error("[web] saveNotifs failed:", e.message)
    }
  },
  now: Date.now,
  WebSocketCtor: WebSocket,
  log: (m) => console.log(m),
  // Slack creds extracted from a live tab (t069). The sweep (t071) reads them via
  // notificationCenter.listCreds(); a fresh extraction triggers an immediate sweep so a
  // newly-attached workspace is caught up without waiting for the next interval.
  onCreds: (rec) => {
    console.log(`[web] slack creds ready: ${rec.teamId} (${rec.name})`)
    if (slackSweeper) slackSweeper.sweepWorkspace(rec).catch(() => {})
  },
  // The Slack hijack (t064) is demoted to a "sweep now" trigger (ADR-0011): a fired
  // notification means something happened, so sweep that workspace immediately for the
  // authoritative, message-anchored entry — sub-second delivery, no double-notify.
  onSlackSignal: (teamId) => {
    const rec = notificationCenter.getCreds(teamId)
    if (rec && rec.fresh !== false && slackSweeper) slackSweeper.sweepWorkspace(rec).catch(() => {})
  },
  onEntry: (entry) => {
    broadcast("notification", entry)
    // Fire-and-forget push to all subscribers; backgrounded PWAs only get the event
    // when delivered via Web Push (the SSE broadcast is foreground-only on iOS).
    sendPushToAll({
      id: entry.id,
      source: entry.source,
      title: entry.title,
      body: entry.body,
      targetId: entry.targetId,
      targetUrl: entry.targetUrl,
      targetEntity: entry.targetEntity,
      adapter: entry.adapter,
      groupKey: entry.groupKey,
      activate: entry.activate,
      icon: entry.icon,
      ts: entry.ts,
      // Conversation identity for the reader deep-route + composer (t080) — present on
      // swept Slack entries, absent elsewhere (the reader stubs those).
      channelId: entry.channelId,
      slackKind: entry.slackKind,
      slackTs: entry.slackTs,
      slackThreadTs: entry.slackThreadTs,
      // Home-screen badge mirror (t080): the SW calls setAppBadge with this.
      unread: notificationCenter.list().filter((n) => !n.read).length,
    })
  },
})
// ---- Slack parked-tab keeper (t070) ---------------------------------------
// Registers each Slack workspace seen as its own tab and recreates a tab for any registered
// workspace with no live tab (closed by the user, or gone after a browser restart) — so the
// sweep's creds self-refresh and the hijack stays armed. Per the user's "fully live" choice,
// this actively provisions tabs via /json/new. Registry persists non-secret metadata only.
let slackRegistry = loadJson(SLACK_WORKSPACES_PATH, {})
const slackCreatedAt = {} // teamId → last /json/new timestamp (create cooldown)
const saveSlackRegistry = () => {
  try {
    writeFileSync(SLACK_WORKSPACES_PATH, JSON.stringify(slackRegistry, null, 2))
  } catch (e) {
    console.error("[web] saveSlackRegistry failed:", e.message)
  }
}

async function keepSlackTabsAlive(targets) {
  // Register every workspace currently seen as its own tab.
  let changed = false
  for (const t of targets) {
    if (t.type !== "page") continue
    const teamId = slackTeamIdOf(t.url || "")
    if (!teamId) continue
    const before = slackRegistry[teamId]
    // enterpriseId (t092) self-populates from the live cred record once extracted; until
    // then keep any previously-persisted value so a cold start still knows the Grid org.
    const enterpriseId =
      notificationCenter.getCreds(teamId)?.enterpriseId ?? before?.enterpriseId ?? ""
    slackRegistry = slackUpsertWorkspace(
      slackRegistry,
      { teamId, url: t.url, name: before?.name, enterpriseId },
      Date.now(),
    )
    if (!before || before.enterpriseId !== enterpriseId) changed = true
  }
  // Recreate a tab for any registered workspace that has no live tab.
  const live = slackLiveTeamIds(targets)
  const plans = slackPlanParkedTabs(slackRegistry, live, slackCreatedAt, Date.now())
  for (const plan of plans) {
    slackCreatedAt[plan.teamId] = Date.now()
    try {
      await fetchJson(endpoints.newTab(host(), port(), plan.url))
      console.log(`[web] parked-tab keeper: recreated Slack tab for ${plan.teamId}`)
    } catch (e) {
      console.error(`[web] parked-tab create failed for ${plan.teamId}:`, e.message)
    }
  }
  if (changed) saveSlackRegistry()
}

// One combined reconcile cycle: notification side-channels + the Slack parked-tab keeper.
// A single /json fetch feeds both so we don't double-poll the remote browser.
async function reconcileCycle() {
  let targets
  try {
    targets = await fetchJson(endpoints.list(host(), port()))
  } catch {
    return
  }
  if (!Array.isArray(targets)) return
  await notificationCenter.reconcile(targets)
  await keepSlackTabsAlive(targets)
}
setInterval(reconcileCycle, 5000)
setTimeout(reconcileCycle, 1000)

// ---- Slack content sweep (t071) -------------------------------------------
// The authoritative Slack capture: polls each workspace's real unread state via the Slack
// web API (using creds extracted in t069) and writes message-anchored entries the hijack no
// longer writes. Completeness is independent of native-app routing, tab focus/sleep/closure,
// and server gaps (caught up via the per-channel watermark). Per-workspace sweep state lives
// in memory — the store's stable-id dedup makes a cold start re-fetch (not re-notify).
const slackSweepState = {
  watermark: {}, // teamId → { channelId: ts }
  seeded: new Set(), // teamIds whose baseline is established
  muted: {}, // teamId → channelId[]
  userNames: {}, // teamId → { userId: name } — lazy users.info cache (t073)
  channelNames: {}, // teamId → { channelId: name } — lazy conversations.info cache (t073)
  meta: {}, // teamId → { seeded, lastSweepOk, lastEntryTs } — health surface (t074)
  alertStatus: {}, // teamId → last health status, gates the one-time degraded alert (t074)
}
const nameCacheGet = (bucket, team, id) => slackSweepState[bucket][team]?.[id]
const nameCacheSet = (bucket, team, id, name) => {
  if (!slackSweepState[bucket][team]) slackSweepState[bucket][team] = {}
  slackSweepState[bucket][team][id] = name
}
const slackSweeper = createSlackSweeper({
  listCreds: () => notificationCenter.listCreds(),
  makeApi: (cred) => createSlackApi({ token: cred.token, cookie: cred.cookie }),
  getWatermark: (t) => slackSweepState.watermark[t] || {},
  setWatermark: (t, w) => {
    slackSweepState.watermark[t] = w
  },
  isSeeded: (t) => slackSweepState.seeded.has(t),
  markSeeded: (t) => slackSweepState.seeded.add(t),
  // Channel Exclude list (t072): the excluded channel ids for this workspace, read live
  // from ui-state (`slackExcludes: {team,channelId,label}[]`) so a mute applies next sweep.
  // The runner passes the merged groupId (t092); excludes are stored keyed by that same
  // groupId (migrateExcludes + excludeTargetFromEntry both key by groupKey), so the filter
  // matches a Grid member's groupId-keyed mute that a teamId query would miss.
  getExcludes: (groupId) => {
    const list = settings.getUiState().slackExcludes
    return Array.isArray(list)
      ? list.filter((e) => e && e.team === groupId).map((e) => e.channelId)
      : []
  },
  getMuted: (t) => slackSweepState.muted[t],
  setMuted: (t, m) => {
    slackSweepState.muted[t] = m
  },
  getSelfUserId: (t) => notificationCenter.getCreds(t)?.selfUserId,
  setSelfUserId: (t, u) => notificationCenter.setSelfUserId(t, u),
  // Lazy name caches for content rendering (t073).
  getUserName: (t, id) => nameCacheGet("userNames", t, id),
  setUserName: (t, id, name) => nameCacheSet("userNames", t, id, name),
  getChannelName: (t, id) => nameCacheGet("channelNames", t, id),
  setChannelName: (t, id, name) => nameCacheSet("channelNames", t, id, name),
  ingestEntry: (entry) => {
    if (!slackSweepState.meta[entry.team]) slackSweepState.meta[entry.team] = {}
    slackSweepState.meta[entry.team].lastEntryTs = entry.ts
    return notificationCenter.ingestSlackEntry(entry)
  },
  markSwept: (t) => {
    if (!slackSweepState.meta[t]) slackSweepState.meta[t] = {}
    slackSweepState.meta[t].seeded = true
    slackSweepState.meta[t].lastSweepOk = Date.now()
  },
  applyReadUpdates: (_team, lastRead) => notificationCenter.applySlackReadUpdates(lastRead),
  // The runner passes the merged groupId (t092) so the read-sync matches the slack:{groupId}
  // groupKey the sweep stamps on entries — not the concrete teamId.
  applyReadByUnread: (groupId, unreadSet) =>
    notificationCenter.applySlackReadByUnread(groupId, unreadSet),
  markStale: (t, reason) => notificationCenter.markCredsStale(t, reason),
  markUnsweepable: (t, reason) => notificationCenter.disableSweep(t, reason),
  now: Date.now,
  log: (m) => console.log(m),
})
// Compute the Slack capture health report from cred records + sweep metadata (t074, t092).
// Rows are merged per Enterprise Grid group (one row per org); `groups` is the teamId →
// groupId map the renderer needs to resolve a Slack Tab/Pin URL (which carries only a
// concrete teamId) to its merged unread/health/mute bucket.
const slackHealthRows = () => buildHealth(notificationCenter.listCreds(), slackSweepState.meta)
const slackHealth = () => ({
  rows: slackHealthRows(),
  groups: buildSlackGroups(notificationCenter.listCreds()),
})

// Fire a one-time "reconnect Slack" alert when a workspace group first degrades (stale creds)
// or is found unsupported (Grid-restricted). Gated by the last-seen status so it never repeats.
function checkSlackHealthAlerts() {
  for (const row of slackHealthRows()) {
    const prev = slackSweepState.alertStatus[row.groupId]
    if (shouldAlert(prev, row.status)) {
      const why =
        row.status === "unsupported"
          ? "can't read this workspace (restricted) — notifications limited"
          : "needs reconnecting — open this Slack workspace to refresh"
      sendPushToAll({
        id: `slack-health:${row.groupId}:${row.status}`,
        source: "CDP Browser",
        title: `Slack: ${row.name}`,
        body: why,
        groupKey: `slack:${row.groupId}`,
        ts: Date.now(),
      })
    }
    slackSweepState.alertStatus[row.groupId] = row.status
  }
}

// Periodic backstop sweep (every 15s) — the hijack trigger + cred-extraction trigger carry
// real-time delivery; this guarantees completeness even if the hijack never fires (tab
// asleep, native-app routing) or a signal was missed. Health alerts piggyback the cycle.
setInterval(() => {
  slackSweeper.runOnce().catch(() => {})
  checkSlackHealthAlerts()
}, 15_000)

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

  // Build identity — always plaintext (never E2E-sealed) so a deploy can be verified
  // with `curl` through a TLS-intercepting proxy without the passphrase. See t036.
  if (p === "/api/version" && !POST) {
    return res
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify({ version: APP_VERSION, sha: GIT_SHA }))
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
      if (settings.getUiState().syncTheme !== before) applyThemeEmulation()
      return res.writeHead(204).end()
    }
    if (p === "/api/theme-source" && !POST) return json(res, settings.getThemeSource())
    if (p === "/api/theme-source" && POST) {
      settings.setThemeSource((await body(req)).source)
      return res.writeHead(204).end()
    }
    if (p === "/api/theme" && POST) {
      themeDark = !!(await body(req)).isDark
      applyThemeEmulation()
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
    if (p === "/api/notifications" && !POST) return json(res, notificationCenter.list())
    // Slack capture health per workspace (t074) — attached/creds/sweep state for the Settings row.
    if (p === "/api/notifications/health" && !POST) return json(res, slackHealth())
    if (p === "/api/notifications/mark-read" && POST)
      return json(res, notificationCenter.markRead((await body(req)).id))
    if (p === "/api/notifications/mark-unread" && POST)
      return json(res, notificationCenter.markUnread((await body(req)).id))
    if (p === "/api/notifications/mark-all-read" && POST)
      return json(res, notificationCenter.markAllRead())
    if (p === "/api/notifications/clear" && POST) return json(res, notificationCenter.clear())
    // Group-level clear (t085): remove every entry in a conversation by id.
    if (p === "/api/notifications/remove" && POST)
      return json(res, notificationCenter.removeMany((await body(req)).ids))
    // Conversation Reader history (t077, ADR-0012): one rendered conversations.history
    // page through the sweep's creds + name caches. Read-only (never touches the
    // watermark); typed errors map to honest HTTP statuses for the reader's states.
    if (p === "/api/slack/history" && POST) {
      const { team, channel } = await body(req)
      if (!team || !channel) return json(res, { error: "missing team/channel" }, 400)
      const cred = notificationCenter.getCreds(team)
      if (!cred || cred.fresh === false) return json(res, { error: "invalid_auth" }, 401)
      const out = await slackSweeper.fetchConversation(cred, channel)
      if (out.error === "invalid_auth") return json(res, out, 401)
      if (out.error === "rate_limited") return json(res, out, 429)
      if (out.error) return json(res, out, 502)
      return json(res, out)
    }
    // Reader composer reply (t078, ADR-0012 §3): one text-only chat.postMessage through
    // the sweep's creds. The reply target ({channel, thread_ts?}) is selected client-side
    // by the single policy owner (src/lib/slack-reply.ts) — the server never re-decides.
    if (p === "/api/slack/reply" && POST) {
      const { team, channel, thread_ts, text } = await body(req)
      if (!team || !channel || !text?.trim()) return json(res, { error: "missing fields" }, 400)
      const cred = notificationCenter.getCreds(team)
      if (!cred || cred.fresh === false) return json(res, { error: "invalid_auth" }, 401)
      const api = createSlackApi({ token: cred.token, cookie: cred.cookie })
      const out = await api.chatPostMessage(channel, text, thread_ts || undefined)
      if (out?.error === "invalid_auth") {
        notificationCenter.markCredsStale(team, "invalid_auth")
        return json(res, { error: "invalid_auth" }, 401)
      }
      if (out?.error === "rate_limited") return json(res, { error: "rate_limited" }, 429)
      if (!out?.ok) return json(res, { error: out?.error || "send_failed" }, 502)
      return json(res, { ok: true, ts: out.ts })
    }
    // Web Push subscriptions — PWA-installed iOS 16.4+. The public key is non-secret;
    // the client uses it as `applicationServerKey` for pushManager.subscribe.
    if (p === "/api/notifications/vapid-public-key" && !POST) {
      return json(res, { key: VAPID_PUBLIC_KEY })
    }
    if (p === "/api/notifications/subscribe" && POST) {
      const sub = await body(req)
      if (!sub?.endpoint) return json(res, { error: "missing endpoint" }, 400)
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
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://localhost")
  if (url.pathname !== "/api/ws") {
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wsClients.add(ws)
    ws.send(JSON.stringify({ t: "ready" }))
    ws.on("message", async (raw) => {
      const text = raw.toString()
      // Ping/pong is control traffic, never E2E-sealed (it carries only the client's own
      // monotonic stamp, no user content) — handle it before the envelope open so it works
      // identically with E2E on or off. The server echoes the stamp unchanged; only the
      // client measures the round-trip against its own clock (t057). Doubles as a keepalive.
      if (text.length < 64 && text.includes('"ping"')) {
        let ping
        try {
          ping = JSON.parse(text)
        } catch {
          ping = null
        }
        if (ping?.t === "ping") {
          try {
            ws.send(JSON.stringify({ t: "pong", seq: ping.seq, ts: ping.ts }))
          } catch {}
          return
        }
      }
      // Ack-after-paint control (t056) — plaintext like ping (a capability flag / a frame
      // id, no user content), handled before the envelope open so it works identically with
      // E2E on or off. `frame-ack-mode` opts the client in (server defers its self-ack and
      // gates the next frame on this client's paint-ack); `frame-ack` is the paint-ack
      // itself, clearing the one-in-flight slot and acking the remote.
      if (text.length < 64 && text.includes('"frame-ack')) {
        let ctrl
        try {
          ctrl = JSON.parse(text)
        } catch {
          ctrl = null
        }
        if (ctrl?.t === "frame-ack-mode") {
          paintAckClients.add(ws)
          return
        }
        if (ctrl?.t === "frame-ack") {
          if (paintAckClients.has(ws)) onClientPaintAck(ctrl.sessionId)
          return
        }
      }
      let parsed
      try {
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
        // Page.screencastFrameAck is handled via the plaintext `frame-ack` control above
        // (or server-self-acked for non-supporting clients) — ignore any stray `send` retry.
        if (method !== "Page.screencastFrameAck") send(method, params)
      } else if (t === "batch") {
        // Same shape as /api/cdp-batch: { items: [{ method, params }, …] }
        applyBatch(parsed.items)
      }
    })
    const onWsGone = () => {
      wsClients.delete(ws)
      // If this was the last supporting client, free the in-flight slot so the next stream
      // (a non-supporting reconnect, or before a new opt-in) isn't blocked by a stale ack.
      if (paintAckClients.delete(ws) && paintAckClients.size === 0) resetPaintAckGate()
    }
    ws.on("close", onWsGone)
    ws.on("error", onWsGone)
  })
})

server.listen(PORT, "0.0.0.0", () =>
  console.log(`[web] http://0.0.0.0:${PORT}  ->  cdp ${host()}:${port()}`),
)
