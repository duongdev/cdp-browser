// Web proxy server — the browser-facing backend for the web port, mirroring what
// Electron's main.js does over IPC, but over plain HTTP: POST for commands, SSE
// for server pushes, no WebSocket on the browser hop, no auth (a reverse proxy +
// auth layer sit in front, outside this repo). Owns one active CDP screencast socket, the
// notification side-channels, and settings.json. See docs/tasks/007.
//
// Run:  CDP_HOST=<remote-ip> CDP_PORT=9222 PORT=7800 node web/server.mjs

import { execFileSync } from "node:child_process"
import nodeCrypto from "node:crypto"
import { createReadStream, existsSync, mkdirSync, readFileSync } from "node:fs"
import http from "node:http"
import { dirname, extname, join, normalize } from "node:path"
import { fileURLToPath } from "node:url"
import Database from "better-sqlite3"
import webpush from "web-push"
import WebSocket, { WebSocketServer } from "ws"
import { atomicWriteFileSync } from "../core/atomic-write.js"
import endpoints from "../core/cdp-endpoints.js"
import { deriveKey, open, seal } from "../core/crypto-envelope.js"
import { createAckGate } from "../core/frame-ack-gate.js"
import { createFrameThrottle } from "../core/frame-throttle.js"
import { recordVisit as historyRecord, visitsFromTabs } from "../core/history-store.js"
import { createLineSplitter } from "../core/line-splitter.js"
import { muteKey, unreadExcluding } from "../core/notif-mutes.js"
import { buildHealth, shouldAlert } from "../core/notification-health.js"
import sidechain from "../core/notifications-sidechain.js"
import { createPaintAckPacer } from "../core/paint-ack-pacer.js"
import { pushSendOptions } from "../core/push-send-options.js"
import { reconcileDeviceId } from "../core/push-subscriptions.js"
import connector from "../core/remote-page-connector.js"
import { isValidConfig, isValidPinsArray } from "../core/request-guards.js"
import { createSettingsStore } from "../core/settings-store.js"
import { createSlackApi } from "../core/slack-api.js"
import { buildSlackGroups } from "../core/slack-creds.js"
import { createSlackSweeper } from "../core/slack-sweep-runner.js"
import { createSweepStatePersister } from "../core/slack-sweep-state.js"
import {
  hasBrokenSlackSession,
  liveTeamIds as slackLiveTeamIds,
  planParkedTabs as slackPlanParkedTabs,
  pruneRegistry as slackPruneRegistry,
  teamIdOf as slackTeamIdOf,
  upsertWorkspace as slackUpsertWorkspace,
} from "../core/slack-workspaces.js"
import { createSweepScheduler } from "../core/sweep-scheduler.js"
import { buildAmsImageContent } from "../core/teams-ams.js"
import { isValidTeamsCursor } from "../core/teams-cursor.js"
import { buildTeamsFilePayload } from "../core/teams-files.js"
import { isValidAmsUrl, rewriteMediaHtml } from "../core/teams-media.js"
import {
  composeTitle as teamsComposeTitle,
  normalizeUserOid as teamsNormalizeUserOid,
  oidFromMri as teamsOidFromMri,
  otherMrisFromId as teamsOtherMrisFromId,
} from "../core/teams-names.js"
import { planTeamsNotifications } from "../core/teams-notify-sweep.js"
import {
  applyQuoteAuthorNames as teamsApplyQuoteAuthorNames,
  quoteAuthorMris as teamsQuoteAuthorMris,
  toReaderMessages as teamsToReaderMessages,
} from "../core/teams-render.js"
import {
  conversationKind as teamsConversationKind,
  getAllPrefs as teamsGetAllPrefs,
  getReadState as teamsGetReadState,
  getUsers as teamsGetUsers,
  listConversations as teamsListConversations,
  markConversationRead as teamsMarkConversationRead,
  markConversationUnread as teamsMarkConversationUnread,
  migrate as teamsMigrate,
  setLocalRead as teamsSetLocalRead,
  setPrefs as teamsSetPrefs,
  setReadHorizon as teamsSetReadHorizon,
  upsertAccount as teamsUpsertAccount,
  upsertConversations as teamsUpsertConversations,
  upsertMessages as teamsUpsertMessages,
  upsertUsers as teamsUpsertUsers,
} from "../core/teams-store.js"
import { isClientDead, shouldSkipClient } from "../core/ws-backpressure.js"

const HERE = dirname(fileURLToPath(import.meta.url))
const DIST = join(HERE, "..", "dist")
// Standalone Teams chat app (t128, ADR-0019) — a second built bundle served at the
// same-origin path /chat, path-scoped so it never shadows the / browser PWA above.
const DIST_CHAT = join(HERE, "..", "dist-chat")
const PORT = Number(process.env.PORT || 7800)
// Persistent data directory (t163). Every stateful file (chat DB, settings, pins/history,
// notifications, push subs, Slack registry/sweep state) defaults under here; on a container deploy
// point DATA_DIR at a mounted volume so a redeploy doesn't wipe folders/labels/read-state. Unset →
// the repo root (the pre-t163 behaviour), so local dev + Electron are unchanged. Per-file _PATH
// env overrides still win for anyone who set them. Created on boot if missing.
const DATA_DIR = process.env.DATA_DIR || join(HERE, "..")
try {
  mkdirSync(DATA_DIR, { recursive: true })
} catch {
  /* already exists / not writable — the individual file writes surface a real error */
}
const dataPath = (name) => join(DATA_DIR, name)
const SETTINGS_PATH = process.env.SETTINGS_PATH || dataPath("web-settings.json")
const NOTIFS_PATH = process.env.NOTIFS_PATH || dataPath("web-notifications.json")
// Slack workspace registry (t070) — non-secret metadata only (teamId → {url,name,lastSeen}).
// Drives the parked-tab keeper so a closed/lost Slack tab is recreated. No creds on disk:
// the shared d cookie + all-team localConfig re-extract from any live Slack tab.
const SLACK_WORKSPACES_PATH = process.env.SLACK_WORKSPACES_PATH || dataPath("slack-workspaces.json")
// Slack sweep read state (t099, ADR-0016) — non-secret {watermark, seeded}. Persisted so a
// restart RESUMES from the watermark (backfilling the downtime gap) instead of re-seeding.
const SLACK_SWEEP_STATE_PATH =
  process.env.SLACK_SWEEP_STATE_PATH || dataPath("slack-sweep-state.json")
// Browser tab title for the web build, set at deploy time. Electron keeps the
// title baked into index.html (it loads the file directly, not via this server).
const APP_TITLE = process.env.APP_TITLE || "CDP Browser"

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
  // Baked into the image by the Docker builder (.gitsha); .git itself isn't shipped to runtime.
  try {
    const baked = readFileSync(join(HERE, "..", ".gitsha"), "utf8").trim()
    if (baked) return baked
  } catch {}
  // Dev / non-Docker: read it live from the checkout.
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
const SUBS_PATH = process.env.SUBS_PATH || dataPath("web-push-subs.json")
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
  persist: (s) => {
    try {
      atomicWriteFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2))
    } catch (e) {
      console.error("[web] settings persist failed:", e.message)
    }
  },
})
// Env wins on first boot so a fresh deploy points at the right host immediately.
if (process.env.CDP_HOST)
  settings.setConfig({ host: process.env.CDP_HOST, port: Number(process.env.CDP_PORT || 9222) })

// ---- browsing history (t103, ADR-0017) ------------------------------------
// CDP exposes no history API, so we record it from the tab poll: reconcileCycle
// diffs the /json snapshot into visits. Shared across devices (the single server
// store), served to the New Tab omnibox via /api/history. Titled by the tab, so
// SPA route changes that never alter the /json url aren't captured — fine for
// suggestions. Now stamped by the caller (pure store needs a clock).
const HISTORY_PATH = process.env.HISTORY_PATH || dataPath("web-history.json")
let history = loadJson(HISTORY_PATH, [])
let lastTabUrls = {} // tabId → last-seen url, for the navigation diff
const saveHistory = () => {
  try {
    atomicWriteFileSync(HISTORY_PATH, JSON.stringify(history))
  } catch (e) {
    console.error("[web] saveHistory failed:", e.message)
  }
}
// Fold new tab-navigation visits into the store; persists only when something changed.
function ingestHistoryFromTabs(tabs, now) {
  const pages = tabs.filter((t) => t.type === "page")
  const { changed, next } = visitsFromTabs(lastTabUrls, pages)
  lastTabUrls = next
  if (changed.length === 0) return
  for (const v of changed) history = historyRecord(history, { ...v, ts: now })
  saveHistory()
}

// Load persisted push subscriptions; treat invalid/missing as empty.
pushSubs = loadJson(SUBS_PATH, [])
const savePushSubs = () => {
  try {
    atomicWriteFileSync(SUBS_PATH, JSON.stringify(pushSubs, null, 2))
  } catch (e) {
    console.error("[web] savePushSubs failed:", e.message)
  }
}

// ---- Teams push (t147) ----------------------------------------------------
// Fully isolated from the CDP-browser push spine above: its own subscription store + send
// path, so a Teams-chat subscriber and its every-new-message pushes never touch the existing
// notification delivery. Capture is a server-side REST poll (trouter realtime is a dead end),
// mirroring the Slack sweep — see teamsNotifySweep + core/teams-notify-sweep.js.
const TEAMS_PUSH_SUBS_PATH = process.env.TEAMS_PUSH_SUBS_PATH || dataPath("teams-push-subs.json")
const TEAMS_NOTIFY_STATE_PATH =
  process.env.TEAMS_NOTIFY_STATE_PATH || dataPath("teams-notify-state.json")
let teamsPushSubs = loadJson(TEAMS_PUSH_SUBS_PATH, [])
if (!Array.isArray(teamsPushSubs)) teamsPushSubs = []
// { watermarks: { convId: lastNotifiedTs }, seeded } — persisted so a restart resumes from the
// watermark instead of re-seeding (which would drop every message that arrived while down).
let teamsNotifyState = (() => {
  const s = loadJson(TEAMS_NOTIFY_STATE_PATH, null)
  return s && typeof s === "object" && s.watermarks ? s : { watermarks: {}, seeded: false }
})()
const saveTeamsPushSubs = () => {
  try {
    atomicWriteFileSync(TEAMS_PUSH_SUBS_PATH, JSON.stringify(teamsPushSubs, null, 2))
  } catch (e) {
    console.error("[web] saveTeamsPushSubs failed:", e.message)
  }
}
const saveTeamsNotifyState = () => {
  try {
    atomicWriteFileSync(TEAMS_NOTIFY_STATE_PATH, JSON.stringify(teamsNotifyState))
  } catch (e) {
    console.error("[web] saveTeamsNotifyState failed:", e.message)
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

// The per-device delivery prefs for a push subscription (t093). Each device persists its
// own master + mute set in device-keyed ui-state (the renderer's remap seam writes them);
// defaults are opt-out — no stored master = on, no stored mutes = nothing muted. A sub
// without a deviceId (legacy record) falls back to the defaults, so it keeps receiving.
// `ui` is the ui-state snapshot, read once by the caller (one read per push, not per sub).
function devicePrefs(ui, deviceId) {
  if (!deviceId) return { master: true, mutes: [] }
  const master = ui[`notificationsEnabled_${deviceId}`]
  const mutes = ui[`notifMutes_${deviceId}`]
  return {
    master: master === undefined ? true : !!master,
    mutes: Array.isArray(mutes) ? mutes : [],
  }
}

// Push the entry to every subscription that wants it (t093). Per device: skip when the
// device master is off OR the device muted this source; otherwise send with a per-device
// `unread` that excludes that device's muted entries, so the home-screen badge stays
// honest per device. Capture is global — the muting only suppresses *this device's* push.
async function sendPushToAll(payload) {
  if (pushSubs.length === 0) return
  const key = muteKey(payload)
  const ui = settings.getUiState()
  const dead = []
  // Verbose, greppable per-device delivery log (t093) so the mute gating can be verified from
  // prod logs: one [push] line per subscription (sent + its per-device unread, or skip+reason)
  // plus a summary. Device id is truncated; no secret in the line.
  let sent = 0
  let mutedN = 0
  let masterOffN = 0
  await Promise.all(
    pushSubs.map(async (sub) => {
      const dev = (sub.deviceId || "nodev").slice(0, 6)
      const { master, mutes } = devicePrefs(ui, sub.deviceId)
      if (!master) {
        masterOffN++
        console.log(`[push]   dev=${dev} skip:master-off`)
        return // device master off — no push, no badge bump
      }
      if (mutes.includes(key)) {
        mutedN++
        console.log(`[push]   dev=${dev} skip:muted(${key})`)
        return // this source muted on this device
      }
      // Recompute from a fresh list at each send (t096, P7) so a mark-read that lands while a
      // prior send is in flight can't leave this device's badge stamped from a stale snapshot.
      const unread = unreadExcluding(notificationCenter.list(), mutes, master)
      const data = JSON.stringify(trimPushPayload({ ...payload, unread }))
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await webpush.sendNotification(sub, data, pushSendOptions())
          sent++
          console.log(`[push]   dev=${dev} sent unread=${unread}`)
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
  console.log(
    `[push] ${key} adapter=${payload.adapter || "-"} -> sent=${sent} muted=${mutedN} masterOff=${masterOffN} dead=${dead.length} of ${pushSubs.length}`,
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
// WS liveness + backpressure (t099). A half-open socket (suspended iPad) never throws on send,
// so without a heartbeat it would buffer frames unboundedly. Ping every interval; reap a client
// that hasn't ponged within the deadline; skip a frame for a client whose send buffer is over
// the cap (fresh-frame-wins) instead of accreting a backlog.
const WS_HEARTBEAT_INTERVAL_MS = 30_000
const WS_PONG_DEADLINE_MS = 70_000 // ~2 missed heartbeats + margin
const WS_FRAME_BUFFER_CAP = 8 * 1024 * 1024 // ~a few frames; over this, drop the frame for that client
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
    // Skip a client whose send buffer is backed up (suspended/slow) — fresh-frame-wins; the
    // heartbeat reaps a truly-dead one. Prevents a half-open socket buffering frames unbounded.
    if (shouldSkipClient(ws.bufferedAmount, WS_FRAME_BUFFER_CAP)) continue
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
// connection drop that didn't surface as a close), free the slot and ack the remote anyway so a
// single lost paint can't wedge the stream forever. The window is ADAPTIVE (t096, P2): an EWMA
// of observed paint-ack latency sizes it to a multiple of normal, never below a 1s floor — so a
// device that legitimately paints slower than a fixed 1s isn't tripped early. The ack arriving
// first cancels it.
const paintAckPacer = createPaintAckPacer()
let paintSentAt = 0
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
  paintSentAt = Date.now()
  clearPaintAckWatchdog()
  paintAckWatchdog = setTimeout(() => {
    const stranded = frameAckGate.outstanding()
    frameAckGate.reset()
    paintAckWatchdog = null
    if (stranded !== null) remotePage.ackFrame(stranded) // release the remote despite no paint
  }, paintAckPacer.windowMs())
  return true
}
// A supporting client painted + acked the outstanding frame: clear the slot, cancel the
// watchdog, and ack the remote so the next frame flows. Any-client ack releases the slot
// (one client is the daily-driver case; the fastest client's ack frees it for the rest).
function onClientPaintAck(sessionId) {
  if (frameAckGate.outstanding() === null) return
  frameAckGate.ackReceived(sessionId)
  if (frameAckGate.outstanding() === null) {
    paintAckPacer.record(Date.now() - paintSentAt) // feed the adaptive window (t096, P2)
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
  console.log("[cdp] remote socket closed -> broadcasting disconnected")
  // A remote drop strands any frame awaiting a paint-ack — free the slot so the next
  // connect's first frame is immediately eligible (no wedge from a pending ack). (t056)
  resetPaintAckGate()
  broadcast("disconnected", {})
})

const connect = (tabId) => {
  console.log(`[cdp] connect tab=${tabId}`)
  return remotePage.connect({ tabId })
}
const invoke = (method, params) => remotePage.invoke(method, params)
const send = (method, params) => remotePage.send(method, params)
const applyThemeEmulation = () => remotePage.applyTheme()

// A coalesced batch of raw CDP commands from the web transport (input + acks).
// The renderer (remote-page) already translated InputIntent → Input.dispatch*; we
// just relay each command to the active socket in order.
function applyBatch(items) {
  for (const c of items || []) if (c?.method) send(c.method, c.params)
}

// ---- Teams chat store (t127, ADR-0019) ------------------------------------
// Server-owned SQLite = the single source of truth for Teams chat state (ADR-0019). Web build
// only — Electron is a shell that loads the served URL, so the native module is never bundled
// there (not in package.json build.files). t127 writes accounts + conversations; the rest of
// the schema ships migration-only. Lives next to the settings file.
const TEAMS_DB_PATH = process.env.TEAMS_DB_PATH || dataPath("web-teams.db")
const teamsDb = new Database(TEAMS_DB_PATH)
teamsMigrate(teamsDb)

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
      atomicWriteFileSync(NOTIFS_PATH, JSON.stringify(list))
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
    sweepScheduler.request(rec.teamId, rec)
  },
  // Teams messaging creds minted from a live Teams tab (t127, ADR-0019). Record the account
  // identity so the chat DB knows this signed-in tenant. Passing this callback is what turns on
  // the Teams cred path in the side-channel — Electron never does, so it structurally stubs.
  onTeamsCreds: (rec) => {
    console.log(`[web] teams creds ready: tenant=${rec.tenant} base=${rec.chatServiceBase}`)
    try {
      teamsUpsertAccount(teamsDb, {
        tenant: rec.tenant,
        userId: rec.userId,
        chatServiceBase: rec.chatServiceBase,
      })
    } catch (e) {
      console.error("[web] teams account upsert failed:", e.message)
    }
  },
  // The Slack hijack (t064) is demoted to a "sweep now" trigger (ADR-0011): a fired
  // notification means something happened, so sweep that workspace immediately for the
  // authoritative, message-anchored entry — sub-second delivery, no double-notify.
  onSlackSignal: (teamId) => {
    const rec = notificationCenter.getCreds(teamId)
    if (rec && rec.fresh !== false) sweepScheduler.request(teamId, rec)
  },
  // A workspace still stale after re-extraction (t099): the live tab's localConfig token is
  // itself stale, so re-extract can't fix it. Close the keeper-owned tab (never a pin) so the
  // keeper recreates it with a fresh token on the next cycle.
  onCredsStuck: (teamId) => reloadStuckSlackTab(teamId),
  onEntry: (entry) => {
    // Verbose prod log (greppable [notif]) — proves the entry's keying: a Grid workspace's
    // entries carry the merged `slack:{groupId}` groupKey (t092) while keeping a concrete team.
    console.log(
      `[notif] +entry id=${entry.id} adapter=${entry.adapter || "-"} groupKey=${entry.groupKey || "-"} team=${entry.team || "-"}`,
    )
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
      // Home-screen badge mirror (t080): the SW calls setAppBadge with this. The count
      // is stamped per-device inside sendPushToAll (t093) — excluding that device's muted
      // sources — so it is intentionally not set here.
    })
  },
})
// ---- Slack parked-tab keeper (t070) ---------------------------------------
// Registers each Slack workspace seen as its own tab and recreates a tab for any registered
// workspace with no live tab (closed by the user, or gone after a browser restart) — so the
// sweep's creds self-refresh and the hijack stays armed. Per the user's "fully live" choice,
// this actively provisions tabs via /json/new. Registry persists non-secret metadata only.
// Pruned on load (t104): a registry poisoned by the pre-t104 keeper — a Slack sign-in
// landing page persisted as a workspace — self-heals instead of reopening its bad tab.
const slackRegistryOnDisk = loadJson(SLACK_WORKSPACES_PATH, {})
let slackRegistry = slackPruneRegistry(slackRegistryOnDisk)
const slackCreatedAt = {} // teamId → last /json/new timestamp (create cooldown)
const saveSlackRegistry = () => {
  try {
    atomicWriteFileSync(SLACK_WORKSPACES_PATH, JSON.stringify(slackRegistry, null, 2))
  } catch (e) {
    console.error("[web] saveSlackRegistry failed:", e.message)
  }
}
if (JSON.stringify(slackRegistryOnDisk) !== JSON.stringify(slackRegistry)) {
  console.log("[web] slack registry pruned (t104): dropped phantom workspaces / stale URLs")
  saveSlackRegistry()
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
      { teamId, name: before?.name, enterpriseId },
      Date.now(),
    )
    if (!before || before.enterpriseId !== enterpriseId) changed = true
  }
  // Recreate a tab for any registered workspace that has no live tab — UNLESS the user has
  // it pinned (t098): a pinned workspace is owned by its pin, so the keeper never spawns a
  // stray duplicate for it. One live Slack tab refreshes every workspace's creds, so capture
  // is unaffected; a cred lifeline (inside planParkedTabs) keeps one tab alive when none is.
  const live = slackLiveTeamIds(targets)
  const pinUrlByTeam = {}
  for (const pin of settings.getPins()) {
    const tid = slackTeamIdOf(pin.url || "")
    if (tid && !pinUrlByTeam[tid]) pinUrlByTeam[tid] = pin.url
  }
  // A dead Slack session (a sign-in / SSO-failure landing page is open) stands the keeper
  // down: every tab it opened would redirect straight back to one (t104).
  const broken = hasBrokenSlackSession(targets)
  const plans = slackPlanParkedTabs(
    slackRegistry,
    live,
    slackCreatedAt,
    Date.now(),
    pinUrlByTeam,
    broken,
  )
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

// Escalation when a Slack workspace stays stale after re-extraction (t099): close its live
// tab so the keeper recreates it with a fresh token — but ONLY when the tab is keeper-owned.
// A pinned workspace is owned by its pin (t098): closing it would disrupt the user, so we
// leave it and let the health surface degrade. A per-team cooldown prevents a reload loop.
const slackStuckReloadAt = {} // teamId → last stuck-reload timestamp
const STUCK_RELOAD_COOLDOWN_MS = 5 * 60 * 1000
async function reloadStuckSlackTab(teamId) {
  if (Date.now() - (slackStuckReloadAt[teamId] || 0) < STUCK_RELOAD_COOLDOWN_MS) return
  const pinned = settings.getPins().some((p) => slackTeamIdOf(p.url || "") === teamId)
  if (pinned) {
    console.log(`[web] slack ${teamId} stuck stale but pinned — leaving it (health degrades)`)
    return
  }
  let targets
  try {
    targets = await fetchJson(endpoints.list(host(), port()))
  } catch {
    return
  }
  const tab = (Array.isArray(targets) ? targets : []).find(
    (t) => t.type === "page" && slackTeamIdOf(t.url || "") === teamId,
  )
  if (!tab) return
  slackStuckReloadAt[teamId] = Date.now()
  try {
    await fetchJson(endpoints.close(host(), port(), tab.id))
    console.log(`[web] slack ${teamId} stuck stale — closed keeper tab for a fresh token`)
  } catch (e) {
    console.error(`[web] slack stuck-reload close failed for ${teamId}:`, e.message)
  }
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
  ingestHistoryFromTabs(targets, Date.now())
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
// Persist {watermark, seeded} across restarts (t099, ADR-0016). Debounced + atomic write;
// getState reads the live sweep state at flush time so the latest watermark wins.
const sweepStatePersister = createSweepStatePersister({
  read: () => loadJson(SLACK_SWEEP_STATE_PATH, null),
  write: (data) => {
    try {
      atomicWriteFileSync(SLACK_SWEEP_STATE_PATH, JSON.stringify(data))
    } catch (e) {
      console.error("[web] sweep-state persist failed:", e.message)
    }
  },
  getState: () => slackSweepState,
})
// Resume on boot: previously-seeded teams fetch since their watermark (backfilling the
// downtime gap) instead of re-seeding from `latest` and silently dropping downtime messages.
{
  const restored = sweepStatePersister.load()
  slackSweepState.watermark = restored.watermark
  for (const t of restored.seeded) slackSweepState.seeded.add(t)
}
const slackSweeper = createSlackSweeper({
  listCreds: () => notificationCenter.listCreds(),
  makeApi: (cred) => createSlackApi({ token: cred.token, cookie: cred.cookie }),
  getWatermark: (t) => slackSweepState.watermark[t] || {},
  setWatermark: (t, w) => {
    slackSweepState.watermark[t] = w
    sweepStatePersister.scheduleFlush()
  },
  isSeeded: (t) => slackSweepState.seeded.has(t),
  markSeeded: (t) => {
    slackSweepState.seeded.add(t)
    sweepStatePersister.scheduleFlush()
  },
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
    const ingested = notificationCenter.ingestSlackEntry(entry)
    // Grid dedup evidence (t092): a null result means an entry with this id (keyed by the
    // merged slack:{groupId}) already exists — i.e. the org pseudo-team + a member workspace
    // produced the same message and it collapsed at ingest. Greppable [dedup].
    if (!ingested) {
      console.log(
        `[dedup] dropped groupKey=${entry.groupKey} ch=${entry.channelId} ts=${entry.ts} (swept via team=${entry.team})`,
      )
    }
    return ingested
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
// Debounced per-workspace sweep trigger (t096, A6): onCreds + onSlackSignal can fire for the
// same workspace within milliseconds — coalesce them into one leading + one trailing sweep so a
// cred-extraction immediately followed by a hijack signal can't double-sweep. The 15s
// all-workspaces backstop (runOnce) has no per-workspace key and stays out of this path.
const sweepScheduler = createSweepScheduler({
  run: (rec) => slackSweeper.sweepWorkspace(rec).catch(() => {}),
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
        // Stamp the adapter so muteKey resolves to the workspace key (`slack:{groupId}`);
        // without it the per-device Slack mute can't gate this alert (t093).
        adapter: "slack",
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
// Single-flight guard (t099): a sweep that hits a 429 Retry-After sleeps past the 15s tick, so
// without this a second (and third) runOnce would stack and pile duplicate load into the exact
// rate-limit we're already backing off from.
let sweepBackstopInFlight = false
setInterval(() => {
  if (sweepBackstopInFlight) return
  sweepBackstopInFlight = true
  slackSweeper
    .runOnce()
    .catch(() => {})
    .finally(() => {
      sweepBackstopInFlight = false
    })
  checkSlackHealthAlerts()
}, 15_000)

// ---- Teams conversation list (t127/t134, ADR-0019) ------------------------
// CA-proof: the conversations GET runs IN-PAGE via the side-channel (the browser's own
// authenticated fetch), never a server-side fetch. Pin to the minted chatServiceBase —
// chatsvcagg.teams.microsoft.com is a proven 401 dead-end. First page = the base URL; older
// pages = the previous response's `_metadata.backwardLink` (an opaque syncState cursor), fetched
// verbatim after the security gate (isValidTeamsCursor) confirms it stays under our chatServiceBase.
// Returns { conversations, cursor } (cursor = next backwardLink or null) or a typed { error }.
async function fetchTeamsConversationsInPage(cred, cursor) {
  if (!cred.chatServiceBase) return { error: "no_base" }
  let url
  if (cursor) {
    // SSRF gate: the cursor is a server-fetched IN-PAGE URL carrying the skypetoken.
    if (!isValidTeamsCursor(cursor, cred.chatServiceBase)) return { error: "bad_cursor" }
    url = cursor
  } else {
    url = `${cred.chatServiceBase}/v1/users/ME/conversations?view=msnp24Equivalent&pageSize=50&startTime=1`
  }
  // The skype token auths the msg service via `Authentication: skypetoken=…` (NOT a Bearer).
  const script = `(async () => {
    try {
      const r = await fetch(${JSON.stringify(url)}, {
        headers: { Authentication: "skypetoken=" + ${JSON.stringify(cred.skypeToken)} },
      })
      if (r.status === 401) return { error: "invalid_auth" }
      if (!r.ok) return { error: "http_" + r.status }
      return await r.json()
    } catch (e) { return { error: "fetch_failed" } }
  })()`
  const result = await notificationCenter.runInTeamsPage(script)
  if (!result) return { error: "no_teams_tab" }
  if (result.error) return { error: result.error }
  return {
    conversations: Array.isArray(result.conversations) ? result.conversations : [],
    cursor: result._metadata?.backwardLink || null,
  }
}

// Mint/reuse creds → in-page conversations fetch → upsert → return the DB view. A 401 in-page
// drives a single re-authz (markTeamsCredsStale re-mints over the live tab) and one retry, then
// a hard typed invalid_auth. The keeper tab is load-bearing: only its MSAL rotates the bearer.
async function teamsConversations(cursor) {
  let cred = notificationCenter.listTeamsCreds().find((c) => c.fresh !== false)
  if (!cred) {
    await notificationCenter.refreshTeamsCreds() // no fresh cred yet — mint over a live Teams tab
    cred = notificationCenter.listTeamsCreds().find((c) => c.fresh !== false)
  }
  if (!cred) return { error: "invalid_auth" }

  let out = await fetchTeamsConversationsInPage(cred, cursor)
  if (out.error === "invalid_auth") {
    await notificationCenter.markTeamsCredsStale(cred.tenant, "invalid_auth") // re-authz (one retry)
    cred = notificationCenter.getTeamsCreds(cred.tenant)
    if (!cred || cred.fresh === false) return { error: "invalid_auth" }
    out = await fetchTeamsConversationsInPage(cred, cursor)
  }
  if (out.error) return { error: out.error === "invalid_auth" ? "invalid_auth" : out.error }

  teamsUpsertAccount(teamsDb, {
    tenant: cred.tenant,
    userId: cred.userId,
    chatServiceBase: cred.chatServiceBase,
  })
  // Return only THIS page's conversations (the client appends + dedups), enriched from the DB view
  // (unread/preview/muted) and t131 name resolution per page. `rows` = the page's non-reserved convs.
  const rows = teamsUpsertConversations(
    teamsDb,
    cred.tenant,
    out.conversations,
    Date.now(),
    cred.userId,
  )
  const pageIds = new Set(rows.map((r) => r.id))
  const convs = teamsListConversations(teamsDb, cred.tenant).filter((c) => pageIds.has(c.id))
  return { conversations: await teamsResolveTitles(cred, convs), cursor: out.cursor }
}

// ---- Teams push notifications (t147) --------------------------------------
// Server-side poll → push, fully isolated from the CDP-browser notification path. Scope is every
// new incoming chat message; the pure planner (core/teams-notify-sweep.js) does the seeding +
// self/system/reserved skipping + watermark bookkeeping.

// Raw last-message arrival time → epoch ms (mirrors teams-store's private toEpochMs).
function teamsLastMessageTs(last) {
  const t = Date.parse(last?.originalarrivaltime || last?.composetime || "")
  return Number.isFinite(t) ? t : null
}

// Send a Teams push to every Teams subscription; prune the ones that come back gone (404/410).
async function sendTeamsPush(payload) {
  if (teamsPushSubs.length === 0) return
  const data = JSON.stringify(payload)
  const dead = []
  await Promise.all(
    teamsPushSubs.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, data, pushSendOptions())
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) dead.push(sub.endpoint)
        else console.error("[teams-push] send failed:", e.statusCode, e.body || e.message)
      }
    }),
  )
  if (dead.length > 0) {
    teamsPushSubs = teamsPushSubs.filter((s) => !dead.includes(s.endpoint))
    saveTeamsPushSubs()
  }
}

// The SHARED PAYLOAD CONTRACT the SW consumes (exact field names). title = sender for a 1:1/self,
// else "{sender} · {topic}" when the group has a topic (topic-less group → just the sender).
function buildTeamsPushPayload(n, rawConv) {
  const topic = rawConv?.threadProperties?.topic
  const sender = n.senderName || "Teams"
  const isGroup = teamsConversationKind(n.convId) === "group"
  const title = isGroup && topic ? `${sender} · ${topic}` : sender
  return {
    type: "teams",
    title,
    body: n.preview,
    convId: n.convId,
    msgId: n.msgId,
    ts: n.ts,
    tag: n.convId,
  }
}

// One capture tick: fetch the RAW conversation page in-page, plan the notifications, send them,
// persist the advanced watermark. No work if nobody's subscribed or there's no Teams cred.
async function teamsNotifySweep() {
  if (teamsPushSubs.length === 0) return
  let cred = notificationCenter.listTeamsCreds().find((c) => c.fresh !== false)
  if (!cred) {
    await notificationCenter.refreshTeamsCreds() // mint over a live Teams tab, like teamsConversations
    cred = notificationCenter.listTeamsCreds().find((c) => c.fresh !== false)
  }
  if (!cred) return

  let out = await fetchTeamsConversationsInPage(cred) // raw lastMessage fields, first page only
  if (out.error === "invalid_auth") {
    await notificationCenter.markTeamsCredsStale(cred.tenant, "invalid_auth")
    cred = notificationCenter.getTeamsCreds(cred.tenant)
    if (!cred || cred.fresh === false) return
    out = await fetchTeamsConversationsInPage(cred)
  }
  if (out.error) return

  const convMap = new Map()
  const conversations = []
  for (const c of out.conversations) {
    const last = c?.lastMessage
    if (!c?.id || !last) continue
    convMap.set(c.id, c)
    conversations.push({
      id: c.id,
      lastMessage: {
        id: last.id,
        from: last.from,
        imdisplayname: last.imdisplayname,
        content: last.content,
        ts: teamsLastMessageTs(last),
        messagetype: last.messagetype,
      },
    })
  }

  const { notifications, state } = planTeamsNotifications({
    conversations,
    state: teamsNotifyState,
    selfId: cred.userId,
  })
  if (state !== teamsNotifyState) {
    teamsNotifyState = state
    saveTeamsNotifyState()
  }
  if (notifications.length > 0)
    console.log(`[teams-push] ${notifications.length} new -> ${teamsPushSubs.length} sub(s)`)
  for (const n of notifications)
    await sendTeamsPush(buildTeamsPushPayload(n, convMap.get(n.convId)))
}

// Poll every 10s. Single-flight so a slow in-page fetch can't stack overlapping sweeps.
let teamsNotifyInFlight = false
setInterval(() => {
  if (teamsNotifyInFlight) return
  teamsNotifyInFlight = true
  teamsNotifySweep()
    .catch((e) => console.error("[teams-push] sweep failed:", e.message))
    .finally(() => {
      teamsNotifyInFlight = false
    })
}, 10_000)

// ---- DM / group-DM name resolution (t131, ADR-0019) -----------------------
// A DM/group-DM has no topic, so its title is built from member display names. CA-proof like the
// rest: the roster + Graph fetches run IN-PAGE. Names are cached by MRI so a re-render is a cache
// hit — resolution only fires for MRIs seen for the first time. Best-effort throughout: any fetch
// failure degrades a conversation to its kind fallback and NEVER fails the list.

// Batch every group-DM roster in ONE in-page call: the 1:1 id already encodes its members, but a
// group-DM's members come from /v1/threads/{id}. Returns { convId: [mri, …] }; a per-thread miss
// just omits that id (→ the group falls back to "Group chat").
async function fetchTeamsGroupRostersInPage(cred, convIds) {
  if (!cred.chatServiceBase || convIds.length === 0) return {}
  const script = `(async () => {
    const ids = ${JSON.stringify(convIds)}
    const out = {}
    await Promise.all(ids.map(async (id) => {
      try {
        const r = await fetch(${JSON.stringify(cred.chatServiceBase)} + "/v1/threads/" + encodeURIComponent(id) + "?view=msnp24Equivalent", {
          headers: { Authentication: "skypetoken=" + ${JSON.stringify(cred.skypeToken)} },
        })
        if (!r.ok) return
        const j = await r.json()
        out[id] = (Array.isArray(j.members) ? j.members : []).map((m) => m && m.id).filter(Boolean)
      } catch (e) {}
    }))
    return out
  })()`
  const res = await notificationCenter.runInTeamsPage(script)
  return res && typeof res === "object" ? res : {}
}

// Resolve MRIs → names in ONE Graph getByIds batch, IN-PAGE. The Graph bearer is read from the
// page's own MSAL cache (the accesstoken entry scoped to graph.microsoft.com) — a localStorage
// read, not a network call, so CA doesn't apply; the POST is the browser's own authenticated
// request. Returns { oid: displayName }; any failure → {} (all misses stay unresolved).
async function resolveTeamsNamesInPage(oids) {
  if (oids.length === 0) return {}
  const script = `(async () => {
    try {
      let key = null
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith("msal.") && k.includes("accesstoken") && k.includes("graph.microsoft.com")) { key = k; break }
      }
      if (!key) return {}
      let bearer = ""
      try { bearer = (JSON.parse(localStorage.getItem(key)) || {}).secret || "" } catch (e) { return {} }
      if (!bearer) return {}
      const r = await fetch("https://graph.microsoft.com/v1.0/directoryObjects/getByIds", {
        method: "POST",
        headers: { Authorization: "Bearer " + bearer, "Content-Type": "application/json" },
        body: JSON.stringify({ ids: ${JSON.stringify(oids)}, types: ["user"] }),
      })
      if (!r.ok) return {}
      const j = await r.json()
      const out = {}
      for (const u of (Array.isArray(j.value) ? j.value : [])) {
        if (u && u.id && u.displayName) out[u.id] = u.displayName
      }
      return out
    } catch (e) { return {} }
  })()`
  const res = await notificationCenter.runInTeamsPage(script)
  return res && typeof res === "object" ? res : {}
}

// Attach a `title` to each conversation: topic'd convs keep their topic (composeTitle passes it
// through); topic-less DMs/group-DMs resolve member names (id-derived for a 1:1, roster-fetched
// for a group-DM), hitting the cache first and Graph-resolving only the misses in one batch.
async function teamsResolveTitles(cred, convs) {
  const selfMri = `8:orgid:${cred.userId || ""}`
  const hasSelf = convs.some((c) => c.kind === "self")
  const mrisByConv = new Map()
  const groupDmIds = []
  for (const c of convs) {
    if (c.topic && c.topic.trim()) continue // topic wins — no name resolution needed
    if (c.kind === "oneOnOne") mrisByConv.set(c.id, teamsOtherMrisFromId(c.id, selfMri))
    else if (c.kind === "group") groupDmIds.push(c.id) // self chat's title is selfName-only
  }

  const cache = new Map()
  try {
    if (groupDmIds.length) {
      const rosters = await fetchTeamsGroupRostersInPage(cred, groupDmIds)
      for (const id of groupDmIds) {
        mrisByConv.set(
          id,
          (rosters[id] || []).filter((m) => m !== selfMri),
        )
      }
    }
    const needed = new Set()
    for (const mris of mrisByConv.values()) for (const m of mris) needed.add(m)
    // Resolve self's own display name in the same batch when a self chat is present, so its
    // "{selfName} (You)" title works even without cred.displayName.
    if (hasSelf && cred.userId) needed.add(selfMri)
    const cached = teamsGetUsers(teamsDb, [...needed])
    for (const [mri, name] of cached) cache.set(mri, name)
    const misses = [...needed].filter((m) => !cache.has(m))
    if (misses.length) {
      const oidMap = await resolveTeamsNamesInPage(misses.map(teamsOidFromMri))
      const resolved = []
      for (const m of misses) {
        const name = oidMap[teamsOidFromMri(m)]
        if (name) {
          resolved.push({ mri: m, displayName: name })
          cache.set(m, name)
        }
      }
      if (resolved.length) teamsUpsertUsers(teamsDb, resolved)
    }
  } catch (e) {
    console.error("[web] teams name resolution failed:", e.message) // degrade to fallback labels
  }

  const selfName = cred.displayName || cache.get(selfMri) || ""
  return convs.map((c) => ({
    ...c,
    title: teamsComposeTitle({
      kind: c.kind,
      topic: c.topic,
      memberNames: (mrisByConv.get(c.id) || []).map((m) => cache.get(m)).filter(Boolean),
      selfName,
    }),
    // The oid whose photo represents this row (t153): a 1:1 → the other member, the self Notes chat
    // → the viewer, a group → none (keeps the initials tile). Undefined when unknown.
    avatarUserId:
      c.kind === "self"
        ? cred.userId || undefined
        : c.kind === "oneOnOne"
          ? teamsOidFromMri((mrisByConv.get(c.id) || [])[0] || "") || undefined
          : undefined,
    // Group facepile (t161): the first few non-self member oids, for the composite avatar.
    memberIds:
      c.kind === "group"
        ? (mrisByConv.get(c.id) || [])
            .map(teamsOidFromMri)
            .filter((oid) => oid && oid !== teamsOidFromMri(cred.userId || ""))
            .slice(0, 3)
        : undefined,
  }))
}

// Resolve each reaction's reactor MRIs → display names for the hover tooltip (t143), reusing the
// SAME cache-first + one-Graph-batch path as teamsResolveTitles. The viewer's own MRI is excluded
// (the client renders it as "You"); `userMris` is stripped from the payload, leaving `reactorNames`
// (names only, best-effort — an unresolved MRI is just omitted). Mutates `messages` in place. Cache-
// warm: once a reactor is known, a repeat poll adds no Graph latency (the misses set is empty).
async function attachTeamsReactorNames(cred, messages) {
  const selfOid = cred.userId || ""
  const isSelfMri = (mri) => teamsOidFromMri(mri) === selfOid
  const needed = new Set()
  for (const m of messages)
    for (const r of m.reactions || [])
      for (const mri of r.userMris || []) if (!isSelfMri(mri)) needed.add(mri)

  const nameByMri = new Map()
  if (needed.size) {
    try {
      const cached = teamsGetUsers(teamsDb, [...needed])
      for (const [mri, name] of cached) nameByMri.set(mri, name)
      const misses = [...needed].filter((m) => !nameByMri.has(m))
      if (misses.length) {
        const oidMap = await resolveTeamsNamesInPage(misses.map(teamsOidFromMri))
        const resolved = []
        for (const m of misses) {
          const name = oidMap[teamsOidFromMri(m)]
          if (name) {
            resolved.push({ mri: m, displayName: name })
            nameByMri.set(m, name)
          }
        }
        if (resolved.length) teamsUpsertUsers(teamsDb, resolved)
      }
    } catch (e) {
      console.error("[web] teams reactor name resolution failed:", e.message) // degrade to no names
    }
  }

  for (const m of messages)
    for (const r of m.reactions || []) {
      const names = (r.userMris || [])
        .filter((mri) => !isSelfMri(mri))
        .map((mri) => nameByMri.get(mri))
        .filter(Boolean)
      r.userMris = undefined
      if (names.length) r.reactorNames = names
    }
}

// Repair reply quotes that name their author "Display Name"/"" (PSN-92 workstream A): collect the
// broken authors' MRIs across the rendered bodies, resolve names cache-first + one Graph batch (same
// seam as reactor names — self MRI included, so a quote of you shows your real name, decision 4), and
// rewrite each body. Best-effort: an unresolved MRI keeps the placeholder. Cache-warm after first hit.
async function attachTeamsQuoteNames(cred, messages) {
  const needed = new Set()
  for (const m of messages)
    if (typeof m.body === "string") for (const mri of teamsQuoteAuthorMris(m.body)) needed.add(mri)
  if (needed.size === 0) return

  const nameByMri = {}
  try {
    const cached = teamsGetUsers(teamsDb, [...needed])
    for (const [mri, name] of cached) nameByMri[mri] = name
    const misses = [...needed].filter((m) => !nameByMri[m])
    if (misses.length) {
      const oidMap = await resolveTeamsNamesInPage(misses.map(teamsOidFromMri))
      const resolved = []
      for (const m of misses) {
        const name = oidMap[teamsOidFromMri(m)]
        if (name) {
          nameByMri[m] = name
          resolved.push({ mri: m, displayName: name })
        }
      }
      if (resolved.length) teamsUpsertUsers(teamsDb, resolved)
    }
  } catch (e) {
    console.error("[web] teams quote author resolution failed:", e.message) // degrade to placeholder
  }

  for (const m of messages)
    if (typeof m.body === "string") m.body = teamsApplyQuoteAuthorNames(m.body, nameByMri)
}

// ---- Teams conversation history (t129/t134, ADR-0019) ---------------------
// CA-proof like the list: the messages GET runs IN-PAGE via the side-channel. First page = the
// base URL; older pages = the previous response's `_metadata.backwardLink` (an opaque syncState
// cursor), fetched verbatim after the security gate (isValidTeamsCursor) confirms it stays under
// our chatServiceBase. Returns { messages: raw[], cursor } or a typed { error }.
async function fetchTeamsHistoryInPage(cred, convId, cursor) {
  if (!cred.chatServiceBase) return { error: "no_base" }
  let url
  if (cursor) {
    // SSRF gate: the cursor is a server-fetched IN-PAGE URL carrying the skypetoken.
    if (!isValidTeamsCursor(cursor, cred.chatServiceBase)) return { error: "bad_cursor" }
    url = cursor
  } else {
    url = `${cred.chatServiceBase}/v1/users/ME/conversations/${encodeURIComponent(convId)}/messages?pageSize=30&view=msnp24Equivalent&startTime=1`
  }
  const script = `(async () => {
    try {
      const r = await fetch(${JSON.stringify(url)}, {
        headers: { Authentication: "skypetoken=" + ${JSON.stringify(cred.skypeToken)} },
      })
      if (r.status === 401) return { error: "invalid_auth" }
      if (!r.ok) return { error: "http_" + r.status }
      return await r.json()
    } catch (e) { return { error: "fetch_failed" } }
  })()`
  const result = await notificationCenter.runInTeamsPage(script)
  if (!result) return { error: "no_teams_tab" }
  if (result.error) return { error: result.error }
  return {
    messages: Array.isArray(result.messages) ? result.messages : [],
    cursor: result._metadata?.backwardLink || null,
  }
}

// Mint/reuse creds → in-page history fetch → render → upsert → return { messages, cursor }. A 401
// drives one re-authz + retry, then a hard typed invalid_auth (mirrors teamsConversations).
async function teamsHistory(convId, cursor, poll) {
  let cred = notificationCenter.listTeamsCreds().find((c) => c.fresh !== false)
  if (!cred) {
    await notificationCenter.refreshTeamsCreds()
    cred = notificationCenter.listTeamsCreds().find((c) => c.fresh !== false)
  }
  if (!cred) return { error: "invalid_auth" }

  let out = await fetchTeamsHistoryInPage(cred, convId, cursor)
  if (out.error === "invalid_auth") {
    await notificationCenter.markTeamsCredsStale(cred.tenant, "invalid_auth")
    cred = notificationCenter.getTeamsCreds(cred.tenant)
    if (!cred || cred.fresh === false) return { error: "invalid_auth" }
    out = await fetchTeamsHistoryInPage(cred, convId, cursor)
  }
  if (out.error) return { error: out.error === "invalid_auth" ? "invalid_auth" : out.error }

  const messages = teamsToReaderMessages(out.messages, cred.userId)
  teamsUpsertMessages(teamsDb, cred.tenant, convId, messages) // persist + advance sync cursors
  await attachTeamsReactorNames(cred, messages) // resolve reaction hover names (t143); strips userMris
  await attachTeamsQuoteNames(cred, messages) // repair "Display Name" reply quotes (PSN-92 A)
  // Q9 hybrid: opening a conversation (first page, no cursor) is a LOCAL read — advance
  // local_read_ts to the newest message, but never write the consumptionHorizon to Teams.
  // A background `poll` of the open thread also advances it (live-viewing = reading) EXCEPT when a
  // mark-unread sentinel (local_read_ts = -1, t155) is armed — only a real open/explicit action
  // clears the sentinel, so "mark unread while the thread is open" survives the 4s poll + a refresh.
  if (cursor == null && messages.length > 0) {
    const sentinel = poll && teamsGetReadState(teamsDb, convId)?.localReadTs === -1
    if (!sentinel) teamsSetLocalRead(teamsDb, cred.tenant, convId, messages[messages.length - 1].ts)
  }
  return { messages, cursor: out.cursor }
}

// ---- Teams AMS media proxy (t139, ADR-0019) -------------------------------
// AMS media (images/video) 401s from a server-side or no-cors fetch — it loads ONLY from an
// IN-PAGE fetch with the skypetoken header (like teamsHistory). So the proxy fetches the object
// through the side-channel and serves the decoded bytes. The in-page reader is FileReader (a data
// URL) — NOT String.fromCharCode over the byte array, which stack-overflows on a real image. An
// LRU (the object id is immutable) avoids re-hitting the side-channel on every scroll.
// ponytail: serves the whole imgo/video object by value over CDP — no thumbnail view, no HTTP
// range/seek. Fine for chat-sized media; add streaming+range if a large video ever stutters (t140+).
const TEAMS_MEDIA_CACHE = new Map() // url -> { ct, buf }
const TEAMS_MEDIA_CACHE_MAX = 64

function teamsMediaCacheGet(url) {
  const hit = TEAMS_MEDIA_CACHE.get(url)
  if (!hit) return null
  TEAMS_MEDIA_CACHE.delete(url) // re-insert marks most-recently-used
  TEAMS_MEDIA_CACHE.set(url, hit)
  return hit
}

function teamsMediaCacheSet(url, entry) {
  TEAMS_MEDIA_CACHE.set(url, entry)
  while (TEAMS_MEDIA_CACHE.size > TEAMS_MEDIA_CACHE_MAX) {
    TEAMS_MEDIA_CACHE.delete(TEAMS_MEDIA_CACHE.keys().next().value) // evict oldest
  }
}

async function fetchTeamsMediaInPage(cred, url) {
  // AMS objects auth with `Authorization: skype_token {sk}` — NOT the msg-service's
  // `Authentication: skypetoken=` form (that 401s for cross-region/other-user AMS objects; only
  // same-region ones happen to accept it). Proven live against the running tenant (t139).
  const script = `(async () => {
    try {
      const r = await fetch(${JSON.stringify(url)}, {
        headers: { Authorization: "skype_token " + ${JSON.stringify(cred.skypeToken)} },
      })
      if (r.status === 401) return { error: "invalid_auth" }
      if (!r.ok) return { error: "http_" + r.status }
      const blob = await r.blob()
      const dataUrl = await new Promise((resolve, reject) => {
        const fr = new FileReader()
        fr.onload = () => resolve(fr.result)
        fr.onerror = () => reject(fr.error)
        fr.readAsDataURL(blob)
      })
      return { ct: blob.type || r.headers.get("content-type") || "application/octet-stream", dataUrl }
    } catch (e) { return { error: "fetch_failed" } }
  })()`
  const result = await notificationCenter.runInTeamsPage(script)
  if (!result) return { error: "no_teams_tab" }
  return result
}

// Mint/reuse creds → in-page media fetch → decode the data URL to bytes. A 401 drives one re-authz
// + retry (mirrors teamsHistory), then a typed invalid_auth. Returns { ct, buf } or { error }.
async function teamsMedia(url) {
  let cred = notificationCenter.listTeamsCreds().find((c) => c.fresh !== false)
  if (!cred) {
    await notificationCenter.refreshTeamsCreds()
    cred = notificationCenter.listTeamsCreds().find((c) => c.fresh !== false)
  }
  if (!cred) return { error: "invalid_auth" }

  let out = await fetchTeamsMediaInPage(cred, url)
  if (out.error === "invalid_auth") {
    await notificationCenter.markTeamsCredsStale(cred.tenant, "invalid_auth")
    cred = notificationCenter.getTeamsCreds(cred.tenant)
    if (!cred || cred.fresh === false) return { error: "invalid_auth" }
    out = await fetchTeamsMediaInPage(cred, url)
  }
  if (out.error) return { error: out.error }

  // Split the `data:{ct};base64,{b64}` the in-page FileReader produced → raw bytes.
  const comma = typeof out.dataUrl === "string" ? out.dataUrl.indexOf(",") : -1
  if (comma === -1) return { error: "bad_data_url" }
  return {
    ct: out.ct || "application/octet-stream",
    buf: Buffer.from(out.dataUrl.slice(comma + 1), "base64"),
  }
}

// ---- Teams user avatars (t153) --------------------------------------------
// Real user photos via Graph `/v1.0/users/{oid}/photos/48x48/$value`, fetched IN-PAGE with the
// page's own Graph bearer (the same MSAL accesstoken teamsResolveTitles uses for getByIds) so
// Conditional Access can't reject it. Best-effort: a user with no photo 404s (common) — that miss
// is cached as a negative so the list can't hammer Graph. Keyed by bare oid (immutable), LRU + neg.
const TEAMS_AVATAR_CACHE = new Map() // oid -> { ct, buf } | { miss: true }
const TEAMS_AVATAR_CACHE_MAX = 256

function teamsAvatarCacheGet(oid) {
  const hit = TEAMS_AVATAR_CACHE.get(oid)
  if (!hit) return null
  TEAMS_AVATAR_CACHE.delete(oid)
  TEAMS_AVATAR_CACHE.set(oid, hit)
  return hit
}

function teamsAvatarCacheSet(oid, entry) {
  TEAMS_AVATAR_CACHE.set(oid, entry)
  while (TEAMS_AVATAR_CACHE.size > TEAMS_AVATAR_CACHE_MAX) {
    TEAMS_AVATAR_CACHE.delete(TEAMS_AVATAR_CACHE.keys().next().value)
  }
}

async function fetchTeamsAvatarInPage(oid) {
  // 48px is enough for a chat avatar; the bearer is a localStorage read (CA doesn't apply), the
  // GET is the browser's own authenticated request. 404 = no photo (negative-cache it).
  const script = `(async () => {
    try {
      let key = null
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith("msal.") && k.includes("accesstoken") && k.includes("graph.microsoft.com")) { key = k; break }
      }
      if (!key) return { error: "no_bearer" }
      let bearer = ""
      try { bearer = (JSON.parse(localStorage.getItem(key)) || {}).secret || "" } catch (e) { return { error: "no_bearer" } }
      if (!bearer) return { error: "no_bearer" }
      const r = await fetch("https://graph.microsoft.com/v1.0/users/${oid}/photos/48x48/$value", {
        headers: { Authorization: "Bearer " + bearer },
      })
      if (r.status === 404) return { miss: true }
      if (r.status === 401 || r.status === 403) return { error: "invalid_auth" }
      if (!r.ok) return { error: "http_" + r.status }
      const blob = await r.blob()
      const dataUrl = await new Promise((resolve, reject) => {
        const fr = new FileReader()
        fr.onload = () => resolve(fr.result)
        fr.onerror = () => reject(fr.error)
        fr.readAsDataURL(blob)
      })
      return { ct: blob.type || r.headers.get("content-type") || "image/jpeg", dataUrl }
    } catch (e) { return { error: "fetch_failed" } }
  })()`
  const result = await notificationCenter.runInTeamsPage(script)
  if (!result) return { error: "no_teams_tab" }
  return result
}

// Resolve one user's avatar → { ct, buf } | { miss: true } | { error }. The in-page Graph fetch
// needs only a Teams tab (any tenant's bearer resolves any oid in that tenant's directory); no
// per-tenant cred juggling like media.
async function teamsAvatar(oid) {
  const out = await fetchTeamsAvatarInPage(oid)
  if (out.miss) return { miss: true }
  if (out.error) return { error: out.error }
  const comma = typeof out.dataUrl === "string" ? out.dataUrl.indexOf(",") : -1
  if (comma === -1) return { error: "bad_data_url" }
  return { ct: out.ct || "image/jpeg", buf: Buffer.from(out.dataUrl.slice(comma + 1), "base64") }
}

// ---- Teams reply + mark-read (t130, ADR-0019) -----------------------------
// CA-proof like the list/history: the send runs IN-PAGE via the side-channel (the browser's own
// authenticated POST). A random 18-digit clientmessageid dedups server-side; Teams echoes back
// the message's OriginalArrivalTime, which IS the message id (epoch ms). No leading zero.
function randomClientMessageId() {
  let id = String(1 + Math.floor(Math.random() * 9))
  for (let i = 1; i < 18; i++) id += Math.floor(Math.random() * 10)
  return id
}

// Shared by the text reply (t130), the image send (t145), and the file send (t146): the reply
// passes plain text with messagetype "Text", the media paths pass the pre-built HTML with
// "RichText/Html". `properties` carries the message extras — the file send passes a JSON-string
// `files` there so Teams renders the SharePoint chip; every other caller omits it (→ {}).
// Populate cred.displayName once from the self oid (users cache → one Graph getByIds), so every
// outgoing message stamps the real `imdisplayname`. Without it Teams bakes the "Display Name"
// placeholder into colleagues' reply quotes of our messages (PSN-92 workstream A). Best-effort:
// a resolution failure leaves the name empty (today's behavior) and never blocks the send.
async function ensureTeamsSelfName(cred) {
  if (cred.displayName || !cred.userId) return
  const selfMri = `8:orgid:${cred.userId}`
  try {
    const cached = teamsGetUsers(teamsDb, [selfMri]).get(selfMri)
    if (cached) {
      cred.displayName = cached
      return
    }
    const oidMap = await resolveTeamsNamesInPage([cred.userId])
    const name = oidMap[cred.userId]
    if (name) {
      cred.displayName = name
      teamsUpsertUsers(teamsDb, [{ mri: selfMri, displayName: name }])
    }
  } catch (e) {
    console.error("[web] teams self-name resolution failed:", e.message)
  }
}

async function sendTeamsMessageInPage(
  cred,
  convId,
  content,
  messagetype = "Text",
  properties = {},
) {
  if (!cred.chatServiceBase) return { error: "no_base" }
  await ensureTeamsSelfName(cred)
  const url = `${cred.chatServiceBase}/v1/users/ME/conversations/${encodeURIComponent(convId)}/messages`
  const clientmessageid = randomClientMessageId()
  const payload = {
    content,
    messagetype,
    contenttype: "text",
    clientmessageid,
    imdisplayname: cred.displayName || "",
    properties,
  }
  const script = `(async () => {
    try {
      const r = await fetch(${JSON.stringify(url)}, {
        method: "POST",
        headers: {
          Authentication: "skypetoken=" + ${JSON.stringify(cred.skypeToken)},
          "Content-Type": "application/json",
        },
        body: ${JSON.stringify(JSON.stringify(payload))},
      })
      if (r.status === 401) return { error: "invalid_auth" }
      if (r.status !== 201 && !r.ok) return { error: "http_" + r.status }
      const j = await r.json().catch(() => ({}))
      return { OriginalArrivalTime: j.OriginalArrivalTime }
    } catch (e) { return { error: "fetch_failed" } }
  })()`
  const result = await notificationCenter.runInTeamsPage(script)
  if (!result) return { error: "no_teams_tab" }
  if (result.error) return { error: result.error }
  return { OriginalArrivalTime: result.OriginalArrivalTime, clientmessageid }
}

// Mint/reuse creds → in-page send → persist the echo → return the new ts. A 401 drives one
// re-authz + retry, then a hard typed invalid_auth (mirrors teamsConversations/teamsHistory).
// `html` (t159, composer formatting) upgrades the wire format to a RichText/Html message; the
// plain-text fast path stays the Text send. The echo persists whichever body was sent.
async function teamsReply(convId, text, html, quoteRefs = []) {
  let cred = notificationCenter.listTeamsCreds().find((c) => c.fresh !== false)
  if (!cred) {
    await notificationCenter.refreshTeamsCreds()
    cred = notificationCenter.listTeamsCreds().find((c) => c.fresh !== false)
  }
  if (!cred) return { error: "invalid_auth" }

  const content = html || text
  const messagetype = html ? "RichText/Html" : "Text"
  // A quoted reply carries `qtdMsgs` (+ formatVariant/hasValidMsgReferences) so Teams renders it as a
  // native reply, not just inline blockquote markup (PSN-92, live-verified against a real reply's wire).
  const properties = quoteRefs.length
    ? {
        qtdMsgs: quoteRefs.map((q) => ({
          messageId: q.messageId,
          sender: q.sender,
          time: q.time,
          message: null,
          validationResult: "Valid",
          sharedRefId: null,
          replyChainId: null,
        })),
        formatVariant: "TEAMS",
        hasValidMsgReferences: true,
      }
    : {}
  let out = await sendTeamsMessageInPage(cred, convId, content, messagetype, properties)
  if (out.error === "invalid_auth") {
    await notificationCenter.markTeamsCredsStale(cred.tenant, "invalid_auth")
    cred = notificationCenter.getTeamsCreds(cred.tenant)
    if (!cred || cred.fresh === false) return { error: "invalid_auth" }
    out = await sendTeamsMessageInPage(cred, convId, content, messagetype, properties)
  }
  if (out.error) return { error: out.error === "invalid_auth" ? "invalid_auth" : out.error }

  const ts = String(out.OriginalArrivalTime)
  const tsMs = Number(out.OriginalArrivalTime) || Date.now()
  // Persist the sent echo (self) so a re-fetch/reconnect shows it without a round-trip.
  teamsUpsertMessages(teamsDb, cred.tenant, convId, [
    {
      id: ts,
      ts: tsMs,
      senderId: cred.userId || null,
      senderName: cred.displayName || "",
      body: html || text,
      self: true,
      edited: false,
      deleted: false,
    },
  ])
  return { ok: true, ts, clientmessageid: out.clientmessageid }
}

// Best-effort write-through mark-read (Q9 hybrid): push the consumptionHorizon to Teams IN-PAGE
// and advance the stored read_horizon_ts. NEVER throws / fails a caller — the reply already
// succeeded; a failed horizon write just leaves the desktop unread as a to-do trail. The exact
// PUT verb/path/body is confirmed live by the keeper tab (see task t130 return notes).
async function markTeamsReadInPage(cred, convId, msgId, ts) {
  if (!cred.chatServiceBase) return { error: "no_base" }
  const url = `${cred.chatServiceBase}/v1/users/ME/conversations/${encodeURIComponent(convId)}/properties?name=consumptionhorizon`
  const horizon = `${msgId};${ts};0`
  const script = `(async () => {
    try {
      const r = await fetch(${JSON.stringify(url)}, {
        method: "PUT",
        headers: {
          Authentication: "skypetoken=" + ${JSON.stringify(cred.skypeToken)},
          "Content-Type": "application/json",
        },
        body: ${JSON.stringify(JSON.stringify({ consumptionhorizon: horizon }))},
      })
      return { status: r.status, ok: r.ok }
    } catch (e) { return { error: "fetch_failed" } }
  })()`
  return (await notificationCenter.runInTeamsPage(script)) || { error: "no_teams_tab" }
}

async function teamsMarkRead(convId, msgId, ts) {
  const cred = notificationCenter.listTeamsCreds().find((c) => c.fresh !== false)
  if (cred) {
    try {
      await markTeamsReadInPage(cred, convId, msgId, ts)
      teamsSetReadHorizon(teamsDb, cred.tenant, convId, ts)
    } catch (e) {
      console.error("[web] teams mark-read failed:", e.message)
    }
  }
  return { ok: true }
}

// ---- Teams reactions (t142, ADR-0019) -------------------------------------
// CA-proof like reply/mark-read: PUT (add) or DELETE (remove) the message's emotions property
// IN-PAGE. Proven live 2026-07-22: PUT/DELETE `{chatServiceBase}/…/messages/{msgId}/properties?
// name=emotions` with body `{"emotions":{"key":"<key>","value":<Date.now()>}}` → 200; PUT adds the
// self mri, DELETE removes it (the key row stays with users:[], which the read path then drops).
async function reactTeamsInPage(cred, convId, msgId, key, remove) {
  if (!cred.chatServiceBase) return { error: "no_base" }
  const url = `${cred.chatServiceBase}/v1/users/ME/conversations/${encodeURIComponent(convId)}/messages/${encodeURIComponent(msgId)}/properties?name=emotions`
  const payload = { emotions: { key, value: Date.now() } }
  const method = remove ? "DELETE" : "PUT"
  const script = `(async () => {
    try {
      const r = await fetch(${JSON.stringify(url)}, {
        method: ${JSON.stringify(method)},
        headers: {
          Authentication: "skypetoken=" + ${JSON.stringify(cred.skypeToken)},
          "Content-Type": "application/json",
        },
        body: ${JSON.stringify(JSON.stringify(payload))},
      })
      if (r.status === 401) return { error: "invalid_auth" }
      if (!r.ok) return { error: "http_" + r.status }
      return { ok: true }
    } catch (e) { return { error: "fetch_failed" } }
  })()`
  return (await notificationCenter.runInTeamsPage(script)) || { error: "no_teams_tab" }
}

// Mint/reuse creds → in-page react → best-effort { ok }. A 401 drives one re-authz + retry, then a
// typed invalid_auth (mirrors teamsReply). The optimistic client already updated; the next poll
// reconciles the true count, so any non-auth error just surfaces as a swallowed { error }.
async function teamsReact(convId, msgId, key, remove) {
  let cred = notificationCenter.listTeamsCreds().find((c) => c.fresh !== false)
  if (!cred) {
    await notificationCenter.refreshTeamsCreds()
    cred = notificationCenter.listTeamsCreds().find((c) => c.fresh !== false)
  }
  if (!cred) return { error: "invalid_auth" }

  let out = await reactTeamsInPage(cred, convId, msgId, key, remove)
  if (out.error === "invalid_auth") {
    await notificationCenter.markTeamsCredsStale(cred.tenant, "invalid_auth")
    cred = notificationCenter.getTeamsCreds(cred.tenant)
    if (!cred || cred.fresh === false) return { error: "invalid_auth" }
    out = await reactTeamsInPage(cred, convId, msgId, key, remove)
  }
  if (out.error) return { error: out.error === "invalid_auth" ? "invalid_auth" : out.error }
  return { ok: true }
}

// ---- Teams edit + delete own message (t144, ADR-0019) ---------------------
// CA-proof like reply/react: PUT (edit) or DELETE (delete) the message IN-PAGE. Proven live
// 2026-07-22: PUT `{chatServiceBase}/…/messages/{msgId}` body {content:"<p>…</p>",
// messagetype:"RichText/Html", contenttype:"text"} → 200 (sets properties.edittime); DELETE the same
// URL → 200 (sets properties.deletetime + blanks content). The read path turns those into the
// existing `edited` flag / `deleted` tombstone, so no store write is needed — the next poll's history
// fetch carries the truth (like teamsReact).
// The edit sends RichText/Html, so the plain text must be HTML-escaped and newline→<br> before it's
// wrapped — the reply path sends messagetype:"Text" (no escaping), so it can't be reused verbatim.
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

async function editTeamsInPage(cred, convId, msgId, text) {
  if (!cred.chatServiceBase) return { error: "no_base" }
  const url = `${cred.chatServiceBase}/v1/users/ME/conversations/${encodeURIComponent(convId)}/messages/${encodeURIComponent(msgId)}`
  const payload = {
    content: `<p>${escapeHtml(text).replace(/\n/g, "<br>")}</p>`,
    messagetype: "RichText/Html",
    contenttype: "text",
  }
  const script = `(async () => {
    try {
      const r = await fetch(${JSON.stringify(url)}, {
        method: "PUT",
        headers: {
          Authentication: "skypetoken=" + ${JSON.stringify(cred.skypeToken)},
          "Content-Type": "application/json",
        },
        body: ${JSON.stringify(JSON.stringify(payload))},
      })
      if (r.status === 401) return { error: "invalid_auth" }
      if (!r.ok) return { error: "http_" + r.status }
      return { ok: true }
    } catch (e) { return { error: "fetch_failed" } }
  })()`
  return (await notificationCenter.runInTeamsPage(script)) || { error: "no_teams_tab" }
}

async function deleteTeamsInPage(cred, convId, msgId) {
  if (!cred.chatServiceBase) return { error: "no_base" }
  const url = `${cred.chatServiceBase}/v1/users/ME/conversations/${encodeURIComponent(convId)}/messages/${encodeURIComponent(msgId)}`
  const script = `(async () => {
    try {
      const r = await fetch(${JSON.stringify(url)}, {
        method: "DELETE",
        headers: { Authentication: "skypetoken=" + ${JSON.stringify(cred.skypeToken)} },
      })
      if (r.status === 401) return { error: "invalid_auth" }
      if (!r.ok) return { error: "http_" + r.status }
      return { ok: true }
    } catch (e) { return { error: "fetch_failed" } }
  })()`
  return (await notificationCenter.runInTeamsPage(script)) || { error: "no_teams_tab" }
}

// Mint/reuse creds → in-page edit/delete → best-effort { ok }. A 401 drives one re-authz + retry,
// then a typed invalid_auth (mirrors teamsReact).
async function teamsEdit(convId, msgId, text) {
  let cred = notificationCenter.listTeamsCreds().find((c) => c.fresh !== false)
  if (!cred) {
    await notificationCenter.refreshTeamsCreds()
    cred = notificationCenter.listTeamsCreds().find((c) => c.fresh !== false)
  }
  if (!cred) return { error: "invalid_auth" }

  let out = await editTeamsInPage(cred, convId, msgId, text)
  if (out.error === "invalid_auth") {
    await notificationCenter.markTeamsCredsStale(cred.tenant, "invalid_auth")
    cred = notificationCenter.getTeamsCreds(cred.tenant)
    if (!cred || cred.fresh === false) return { error: "invalid_auth" }
    out = await editTeamsInPage(cred, convId, msgId, text)
  }
  if (out.error) return { error: out.error === "invalid_auth" ? "invalid_auth" : out.error }
  return { ok: true }
}

async function teamsDelete(convId, msgId) {
  let cred = notificationCenter.listTeamsCreds().find((c) => c.fresh !== false)
  if (!cred) {
    await notificationCenter.refreshTeamsCreds()
    cred = notificationCenter.listTeamsCreds().find((c) => c.fresh !== false)
  }
  if (!cred) return { error: "invalid_auth" }

  let out = await deleteTeamsInPage(cred, convId, msgId)
  if (out.error === "invalid_auth") {
    await notificationCenter.markTeamsCredsStale(cred.tenant, "invalid_auth")
    cred = notificationCenter.getTeamsCreds(cred.tenant)
    if (!cred || cred.fresh === false) return { error: "invalid_auth" }
    out = await deleteTeamsInPage(cred, convId, msgId)
  }
  if (out.error) return { error: out.error === "invalid_auth" ? "invalid_auth" : out.error }
  return { ok: true }
}

// ---- Teams send image attachment (t145, ADR-0019) -------------------------
// CA-proof like reply/edit: the whole AMS upload runs IN-PAGE (the ic3 token is session/CA-bound like
// the skypetoken). Proven live 2026-07-22: read the ic3.teams.office.com MSAL access token + the
// api.spaces bearer → authz for the skypetoken/base/amsV2 → POST {amsV2}/v1/objects/ (create) → PUT
// …/content/imgpsh (bytes) → send a RichText/Html message with the AMSImage <img> (display view imgo).
// The load-bearing headers are `x-ms-migration: True` + `x-ms-client-version` — without them AMS
// falls back to the UA and 400s.
// ponytail: hardcoded AMS build id — AMS accepts it now; if it starts 400ing on a stale version,
// extract the live Teams build version from the page (window.__ or the MSAL app metadata).
const TEAMS_AMS_CLIENT_VERSION = "1415/26061118216"

// Create the AMS object + upload the raw bytes IN-PAGE. Returns { objId, host } (host = the amsV2
// display origin the sent <img> points at) or a typed { error }. A missing ic3/api.spaces token or a
// 401 on create/upload → invalid_auth (the caller drives one re-authz + retry, like teamsReply).
async function createTeamsAmsObjectInPage(convId, filename, base64) {
  const script = `(async () => {
    try {
      // The AMS auth (ic3) + the bearer to mint sk/base/amsV2 (api.spaces) both live in the page's
      // MSAL cache — a localStorage read, not a network call, so CA doesn't apply.
      let sb = null, ic3 = null
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith("msal.") && k.includes("accesstoken") && k.includes("ic3.teams.office.com")) {
          try { const j = JSON.parse(localStorage.getItem(k)); if (j && j.secret) ic3 = j.secret } catch (e) {}
        }
        if (k.startsWith("msal.") && k.includes("accesstoken") && k.toLowerCase().includes("api.spaces.skype.com")) {
          try { const j = JSON.parse(localStorage.getItem(k)); if (j && j.secret) sb = j.secret } catch (e) {}
        }
      }
      if (!ic3 || !sb) return { error: "invalid_auth" }
      const az = await (await fetch("https://teams.microsoft.com/api/authsvc/v1.0/authz", {
        method: "POST",
        headers: { Authorization: "Bearer " + sb, "Content-Type": "application/json" },
        body: "{}",
      })).json()
      const host = ((az.regionGtms && az.regionGtms.amsV2) || "https://as-prod.asyncgw.teams.microsoft.com").replace(/\\/$/, "")
      const amsH = {
        Authorization: "Bearer " + ic3,
        "x-ms-migration": "True",
        "x-ms-client-version": ${JSON.stringify(TEAMS_AMS_CLIENT_VERSION)},
      }
      const cr = await fetch(host + "/v1/objects/", {
        method: "POST",
        headers: { ...amsH, "Content-Type": "application/json" },
        body: JSON.stringify({ type: "pish/image", permissions: { [${JSON.stringify(convId)}]: ["read"] }, sharingMode: "Inline", filename: ${JSON.stringify(filename)} }),
      })
      if (cr.status === 401) return { error: "invalid_auth" }
      const cj = await cr.json().catch(() => ({}))
      const objId = cj.id || null
      if (!objId) return { error: "http_" + cr.status }
      const bytes = Uint8Array.from(atob(${JSON.stringify(base64)}), (c) => c.charCodeAt(0))
      const up = await fetch(host + "/v1/objects/" + objId + "/content/imgpsh", {
        method: "PUT",
        headers: { ...amsH, "Content-Type": "application/octet-stream" },
        body: bytes,
      })
      if (up.status === 401) return { error: "invalid_auth" }
      if (up.status !== 201 && !up.ok) return { error: "http_" + up.status }
      return { objId, host }
    } catch (e) { return { error: "fetch_failed" } }
  })()`
  const result = await notificationCenter.runInTeamsPage(script)
  if (!result) return { error: "no_teams_tab" }
  return result
}

// Mint/reuse creds → in-page AMS create+upload → build the AMSImage content → in-page send. A 401 on
// either half drives one re-authz + retry, then a hard typed invalid_auth (mirrors teamsReply).
// Returns { ok, msgId } (msgId = OriginalArrivalTime, which is the message id/ts).
async function teamsUploadImage({ convId, filename, base64, width, height, text }) {
  let cred = notificationCenter.listTeamsCreds().find((c) => c.fresh !== false)
  if (!cred) {
    await notificationCenter.refreshTeamsCreds()
    cred = notificationCenter.listTeamsCreds().find((c) => c.fresh !== false)
  }
  if (!cred) return { error: "invalid_auth" }

  let content = null
  const run = async () => {
    const ams = await createTeamsAmsObjectInPage(convId, filename, base64)
    if (ams.error) return ams
    content = buildAmsImageContent({
      host: ams.host,
      objId: ams.objId,
      width,
      height,
      caption: text,
    })
    return await sendTeamsMessageInPage(cred, convId, content, "RichText/Html")
  }

  let out = await run()
  if (out.error === "invalid_auth") {
    await notificationCenter.markTeamsCredsStale(cred.tenant, "invalid_auth")
    cred = notificationCenter.getTeamsCreds(cred.tenant)
    if (!cred || cred.fresh === false) return { error: "invalid_auth" }
    out = await run()
  }
  if (out.error) return { error: out.error === "invalid_auth" ? "invalid_auth" : out.error }

  const ts = String(out.OriginalArrivalTime)
  const tsMs = Number(out.OriginalArrivalTime) || Date.now()
  // Persist the sent echo (self) so a re-fetch/reconnect shows it before the real history lands. The
  // AMS src is rewritten to the media proxy so the stored copy renders authenticated (like the read
  // path's toReaderMessages).
  teamsUpsertMessages(teamsDb, cred.tenant, convId, [
    {
      id: ts,
      ts: tsMs,
      senderId: cred.userId || null,
      senderName: cred.displayName || "",
      body: rewriteMediaHtml(content),
      self: true,
      edited: false,
      deleted: false,
    },
  ])
  return { ok: true, msgId: ts }
}

// Upload the raw bytes to the user's SharePoint drive + mint a share link, all IN-PAGE (CA-proof
// like the AMS image path). Returns { driveItem:{id, sharepointIds}, shareUrl, myHost, userPath } or
// a typed { error }. The SharePoint bearer + host are read from the page's MSAL cache; a missing
// token or a 401 on any SharePoint call → invalid_auth (the caller drives one re-authz + retry).
async function uploadTeamsFileInPage(filename, base64) {
  const script = `(async () => {
    try {
      // The SharePoint bearer + host live in the page's MSAL cache — a localStorage read, not a
      // network call, so CA doesn't apply. The token's target scope names the -my.sharepoint.com host.
      let sp = null, myHost = null
      const rx = /https?:\\/\\/([a-z0-9-]+-my\\.sharepoint\\.com)/
      for (const k of Object.keys(localStorage)) {
        if (!(k.startsWith("msal.") && k.includes("accesstoken"))) continue
        try {
          const j = JSON.parse(localStorage.getItem(k))
          const m = j && j.target && String(j.target).match(rx)
          if (m && j.secret) { sp = j.secret; myHost = m[1]; break }
        } catch (e) {}
      }
      if (!sp || !myHost) return { error: "invalid_auth" }
      const bearer = { Authorization: "Bearer " + sp }
      // me/drive → webUrl carries /personal/{userPath}/Documents; pull the {userPath} segment out.
      const drv = await fetch("https://" + myHost + "/_api/v2.0/me/drive", {
        headers: { ...bearer, Accept: "application/json" },
      })
      if (drv.status === 401) return { error: "invalid_auth" }
      const dj = await drv.json().catch(() => ({}))
      const parts = String(dj.webUrl || "").split("/personal/")
      const userPath = parts.length > 1 ? parts[1].split("/")[0] : ""
      if (!userPath) return { error: "http_" + drv.status }
      // Scenario headers mirror Teams' own composer upload.
      const scen = { scenario: "ShareUploadFile", scenariotype: "AUO" }
      const bytes = Uint8Array.from(atob(${JSON.stringify(base64)}), (c) => c.charCodeAt(0))
      const put = await fetch(
        "https://" + myHost + "/_api/v2.0/drive/root:/Microsoft Teams Chat Files/" +
          encodeURIComponent(${JSON.stringify(filename)}) + ":/content",
        {
          method: "PUT",
          headers: { ...bearer, ...scen, "Content-Type": "application/octet-stream" },
          body: bytes,
        },
      )
      if (put.status === 401) return { error: "invalid_auth" }
      if (put.status !== 201 && !put.ok) return { error: "http_" + put.status }
      const item = await put.json().catch(() => ({}))
      if (!item || !item.id) return { error: "http_" + put.status }
      const link = await fetch(
        "https://" + myHost + "/_api/v2.0/drive/items/" + encodeURIComponent(item.id) + "/createLink",
        {
          method: "POST",
          headers: { ...bearer, ...scen, "Content-Type": "application/json" },
          body: JSON.stringify({ type: "view", scope: "organization" }),
        },
      )
      if (link.status === 401) return { error: "invalid_auth" }
      if (link.status !== 201 && !link.ok) return { error: "http_" + link.status }
      const lj = await link.json().catch(() => ({}))
      const shareUrl = lj && lj.link && lj.link.webUrl
      if (!shareUrl) return { error: "http_" + link.status }
      return {
        driveItem: { id: item.id, sharepointIds: item.sharepointIds || null },
        shareUrl, myHost, userPath,
      }
    } catch (e) { return { error: "fetch_failed" } }
  })()`
  const result = await notificationCenter.runInTeamsPage(script)
  if (!result) return { error: "no_teams_tab" }
  return result
}

// Mint/reuse creds → in-page SharePoint upload+share → build the file descriptor → in-page send with
// properties.files. A 401 on either half drives one re-authz + retry, then a hard typed invalid_auth
// (mirrors teamsUploadImage). Returns { ok, msgId } (msgId = OriginalArrivalTime = the message id/ts).
async function teamsUploadFile({ convId, filename, base64, text }) {
  let cred = notificationCenter.listTeamsCreds().find((c) => c.fresh !== false)
  if (!cred) {
    await notificationCenter.refreshTeamsCreds()
    cred = notificationCenter.listTeamsCreds().find((c) => c.fresh !== false)
  }
  if (!cred) return { error: "invalid_auth" }

  // A caption rides as the message content (RichText/Html) above the file chip; empty → no bubble.
  const caption = text && String(text).trim() ? escapeHtml(text).replace(/\n/g, "<br>") : ""
  const run = async () => {
    const up = await uploadTeamsFileInPage(filename, base64)
    if (up.error) return up
    const fileObj = buildTeamsFilePayload({
      myHost: up.myHost,
      userPath: up.userPath,
      driveItem: up.driveItem,
      shareUrl: up.shareUrl,
      filename,
    })
    return await sendTeamsMessageInPage(cred, convId, caption, "RichText/Html", {
      files: JSON.stringify([fileObj]),
    })
  }

  let out = await run()
  if (out.error === "invalid_auth") {
    await notificationCenter.markTeamsCredsStale(cred.tenant, "invalid_auth")
    cred = notificationCenter.getTeamsCreds(cred.tenant)
    if (!cred || cred.fresh === false) return { error: "invalid_auth" }
    out = await run()
  }
  if (out.error) return { error: out.error === "invalid_auth" ? "invalid_auth" : out.error }

  const ts = String(out.OriginalArrivalTime)
  const tsMs = Number(out.OriginalArrivalTime) || Date.now()
  // Persist the sent echo (self) so a re-fetch shows the caption before the live poll lands. The file
  // chip isn't persisted — the store keeps only the body — so it re-derives from the next poll's
  // properties.files (like the image echo, whose <img> lives in its stored body).
  teamsUpsertMessages(teamsDb, cred.tenant, convId, [
    {
      id: ts,
      ts: tsMs,
      senderId: cred.userId || null,
      senderName: cred.displayName || "",
      body: caption,
      self: true,
      edited: false,
      deleted: false,
    },
  ])
  return { ok: true, msgId: ts }
}

// ---- HTTP routing ---------------------------------------------------------
const BODY_LIMIT = 1024 * 1024 // 1 MB — guards against memory exhaustion; CDP payloads are tiny
// A pasted screenshot as base64 JSON dwarfs 1 MB, so the image-upload route reads with a larger cap
// (t145). Still bounded to guard memory — Teams itself rejects larger inline images.
const IMAGE_BODY_LIMIT = 24 * 1024 * 1024 // 24 MB
// A non-image file upload (t146) rides base64 too; cap it larger — ~30 MB of file is ~40 MB encoded.
const FILE_BODY_LIMIT = 40 * 1024 * 1024 // 40 MB
const body = (req, limit = BODY_LIMIT) =>
  new Promise((resolve, reject) => {
    let b = ""
    req.on("data", (c) => {
      b += c
      if (b.length > limit) {
        req.destroy()
        reject(new Error("request body too large"))
      }
    })
    req.on("end", () => {
      try {
        if (!b) return resolve({})
        resolve(e2eKey ? open(b.trim(), e2eKey) : JSON.parse(b))
      } catch {
        // A malformed / undecryptable body used to resolve `{}`, which then persisted and could
        // wipe pins/config. Reject with a tagged error so the handler answers 400 and nothing
        // is written (t099). An empty body still resolves `{}` above (valid for bodyless POSTs).
        reject(Object.assign(new Error("malformed request body"), { badBody: true }))
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

// Serve the built Teams chat app (t128) under /chat: static assets stream, and any deep link
// falls back to the SPA index. Rooted at DIST_CHAT and prefix-stripped so it can never reach
// into DIST (the / build) or above the output dir.
function serveChat(req, res, pathname) {
  const sub = pathname.replace(/^\/chat/, "") || "/"
  const rel = normalize(sub).replace(/^(\.\.[/\\])+/, "")
  let file = join(DIST_CHAT, rel === "/" ? "index.html" : rel)
  if (!existsSync(file) || !file.startsWith(DIST_CHAT)) file = join(DIST_CHAT, "index.html") // SPA fallback
  if (!existsSync(file)) return res.writeHead(404).end("build the chat app: pnpm chat:build")
  const type = file.endsWith(".webmanifest")
    ? "application/manifest+json"
    : MIME[extname(file)] || "application/octet-stream"
  res.writeHead(200, { "Content-Type": type })
  createReadStream(file).pipe(res)
}

// Verbose request log (greppable [req]/[err]) for prod issue-detection. The hot input +
// long-poll paths are suppressed unless they error, so per-frame/per-input traffic never
// floods the log (and never degrades the prod we're watching); every other request logs
// method+path+status+duration when it finishes.
const HOT_PATHS = new Set(["/api/cdp-batch", "/api/send", "/api/input-stream", "/api/events"])
function reqLog(req, res, p) {
  const t0 = Date.now()
  res.on("finish", () => {
    if (HOT_PATHS.has(p) && res.statusCode < 400) return
    const tag = res.statusCode >= 500 ? "[err]" : "[req]"
    console.log(`${tag} ${req.method} ${p} ${res.statusCode} ${Date.now() - t0}ms`)
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x")
  const p = url.pathname
  const POST = req.method === "POST"
  reqLog(req, res, p)

  if (p === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    })
    res.write("retry: 2000\n\n")
    sseClients.add(res)
    console.log(`[client] sse +1 (now ${sseClients.size})`)
    req.on("close", () => {
      sseClients.delete(res)
      console.log(`[client] sse -1 (now ${sseClients.size})`)
    })
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
      const cfg = await body(req)
      // Shape-guard so a wrong/empty body can't wipe the CDP address (t099).
      if (!isValidConfig(cfg)) return json(res, { error: "invalid config" }, 400)
      settings.setConfig(cfg)
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
    if (p === "/api/pins/reorder" && POST) {
      const { pins } = await body(req)
      // Shape-guard so a wrong/empty body can't blow away the pin list (t099).
      if (!isValidPinsArray(pins)) return json(res, { error: "invalid pins" }, 400)
      return json(res, settings.reorderPins(pins))
    }
    // history (t103) — the New Tab omnibox source; record is for the Electron sync client.
    if (p === "/api/history" && !POST) return json(res, history)
    if (p === "/api/history/record" && POST) {
      const { url, title, ts } = await body(req)
      if (typeof url === "string" && /^https?:\/\//i.test(url)) {
        history = historyRecord(history, { url, title: title || "", ts: ts || Date.now() })
        saveHistory()
      }
      return res.writeHead(204).end()
    }
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
    // Teams chat: the authenticated conversation list (t127/t134, ADR-0019). Mints creds via the
    // keeper tab, fetches a page IN-PAGE (CA-proof), upserts into the chat DB, returns the page +
    // a `cursor` (backwardLink) for the next older page. POST so the opaque cursor URL rides the
    // body, never a query. Web build only (Electron has no scrapable Teams creds path).
    if (p === "/api/teams/conversations" && POST) {
      const { cursor } = await body(req)
      const out = await teamsConversations(cursor)
      if (out.error === "invalid_auth") return json(res, out, 401)
      if (out.error === "bad_cursor") return json(res, out, 400)
      if (out.error) return json(res, out, 502)
      return json(res, out)
    }
    // Teams chat: one conversation's message history (t129/t134, ADR-0019). Fetches IN-PAGE,
    // renders to ReaderMessages, persists, returns { messages, cursor }. No `cursor` → first
    // page; a `cursor` (backwardLink) pages older after the SSRF gate. Web only.
    if (p === "/api/teams/history" && POST) {
      const { convId, cursor, poll } = await body(req)
      if (!convId) return json(res, { error: "missing convId" }, 400)
      const out = await teamsHistory(convId, cursor, !!poll)
      if (out.error === "invalid_auth") return json(res, out, 401)
      if (out.error === "bad_cursor") return json(res, out, 400)
      if (out.error) return json(res, out, 502)
      return json(res, out)
    }
    // Teams chat: send a text reply IN-PAGE (t130, ADR-0019). Persists the echo, returns the
    // new ts. A 401 → one re-authz + retry → typed invalid_auth. Web only.
    if (p === "/api/teams/reply" && POST) {
      const { convId, text, html, quotes } = await body(req)
      if (!convId || !text?.trim()) return json(res, { error: "missing fields" }, 400)
      // Optional composer-formatted HTML body (t159): string-typed + size-capped, else ignored.
      const richHtml = typeof html === "string" && html.trim() && html.length <= 65536 ? html : null
      // Quoted-message references (PSN-92 B/C): shape-guard each so a proper native reply carries
      // `qtdMsgs` (Teams renders it as a real reply — clickable jump — not just inline blockquote).
      const refs = Array.isArray(quotes)
        ? quotes
            .filter(
              (q) => q && Number.isFinite(Number(q.messageId)) && typeof q.sender === "string",
            )
            .slice(0, 10)
            .map((q) => ({
              messageId: Number(q.messageId),
              sender: q.sender,
              time: Number(q.time ?? q.messageId),
            }))
        : []
      const out = await teamsReply(convId, text, richHtml, refs)
      if (out.error === "invalid_auth") return json(res, out, 401)
      if (out.error) return json(res, out, 502)
      return json(res, out)
    }
    // Teams chat: AMS media proxy (t139, ADR-0019). The rendered <img>/<video> src points here;
    // the server fetches the authenticated AMS object IN-PAGE (CA-proof — a server-side fetch 401s)
    // and serves the raw bytes so the browser caches them normally (no data URLs in the DOM). The
    // response is plaintext binary (never E2E-sealed — an <img> src can't decrypt), SSRF-gated by
    // isValidAmsUrl, LRU-cached. Web only. GET so it slots straight into an <img>/<video> src.
    if (p === "/api/teams/media" && !POST) {
      const target = url.searchParams.get("url") || ""
      if (!isValidAmsUrl(target)) return res.writeHead(400).end("bad url")
      const hit = teamsMediaCacheGet(target) || (await teamsMedia(target))
      if (hit.error) return res.writeHead(502).end(hit.error)
      // Only ever serve image/video bytes on our origin — never render an arbitrary content-type
      // (nosniff + an explicit allowlist so a non-media AMS object can't become same-origin HTML; t139 review).
      if (!/^(image|video)\//.test(hit.ct || "")) return res.writeHead(502).end("bad media type")
      teamsMediaCacheSet(target, hit)
      return res
        .writeHead(200, {
          "Content-Type": hit.ct,
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "public, max-age=604800, immutable",
        })
        .end(hit.buf)
    }
    // Teams chat: real user avatar via Graph photo (t153). userId is an oid/MRI (never a URL) —
    // shape-guarded by teamsNormalizeUserOid (SSRF). 404/no-photo → 204 so the client keeps
    // initials; the miss is negative-cached. Serves image bytes with nosniff. Web only.
    if (p === "/api/teams/avatar" && !POST) {
      const oid = teamsNormalizeUserOid(url.searchParams.get("userId") || "")
      if (!oid) return res.writeHead(400).end("bad userId")
      let hit = teamsAvatarCacheGet(oid)
      if (!hit) {
        hit = await teamsAvatar(oid)
        if (hit.miss || (hit.ct && /^image\//.test(hit.ct))) teamsAvatarCacheSet(oid, hit)
      }
      if (hit.miss) return res.writeHead(204).end()
      if (hit.error) return res.writeHead(502).end(hit.error)
      if (!/^image\//.test(hit.ct || "")) return res.writeHead(502).end("bad media type")
      return res
        .writeHead(200, {
          "Content-Type": hit.ct,
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "public, max-age=86400",
        })
        .end(hit.buf)
    }
    // Teams chat: write-through mark-read (t130, Q9 hybrid). Best-effort — always { ok } even
    // if the horizon write fails, so it can't undo a successful reply. Web only.
    if (p === "/api/teams/mark-read" && POST) {
      const { convId, msgId, ts } = await body(req)
      if (!convId || !msgId || ts == null) return json(res, { error: "missing fields" }, 400)
      return json(res, await teamsMarkRead(convId, msgId, ts))
    }
    // Teams chat: LOCAL-only read state (t155, Q9 hybrid). Writes read_state in the chat DB and
    // NEVER touches Teams (no consumptionHorizon write) — the desktop unread survives as a to-do
    // trail. `action`: "read" advances local_read_ts to `ts` (or clears a mark-unread sentinel);
    // "unread" sets the sticky sentinel that re-arms the dot past an advancing Teams horizon. Web only.
    if (p === "/api/teams/read-local" && POST) {
      const { convId, action, ts } = await body(req)
      if (!convId || (action !== "read" && action !== "unread"))
        return json(res, { error: "missing fields" }, 400)
      const cred = notificationCenter.listTeamsCreds().find((c) => c.fresh !== false)
      const tenant = cred?.tenant
      if (!tenant) return json(res, { error: "invalid_auth" }, 401)
      if (action === "read") teamsMarkConversationRead(teamsDb, tenant, convId, Number(ts) || 0)
      else teamsMarkConversationUnread(teamsDb, tenant, convId)
      return json(res, { ok: true })
    }
    // Teams chat: LOCAL conversation prefs (t156, Workstream K) — labels, folder, mute. All local to
    // this store, NEVER written to Teams; shared across every device (not device-keyed). GET returns
    // every conversation's prefs (a map the client holds beside the list + re-applies over polls);
    // POST patches one conversation (only the provided keys). Web only. No cred needed — prefs are
    // keyed by convId, not tenant.
    if (p === "/api/teams/prefs" && !POST) return json(res, { prefs: teamsGetAllPrefs(teamsDb) })
    if (p === "/api/teams/prefs" && POST) {
      const { convId, labels, folder, muted } = await body(req)
      if (!convId) return json(res, { error: "missing fields" }, 400)
      const patch = {}
      if (labels !== undefined) patch.labels = labels
      if (folder !== undefined) patch.folder = folder
      if (muted !== undefined) patch.muted = muted
      return json(res, { ok: true, prefs: teamsSetPrefs(teamsDb, convId, patch) })
    }
    // Teams chat: add/remove the viewer's reaction on a message IN-PAGE (t142, ADR-0019). Best-effort
    // { ok } — the client is optimistic and the poll reconciles. A 401 → one re-authz + retry. Web only.
    if (p === "/api/teams/react" && POST) {
      const { convId, msgId, key, remove } = await body(req)
      if (!convId || !msgId || !key) return json(res, { error: "missing fields" }, 400)
      const out = await teamsReact(convId, msgId, key, !!remove)
      if (out.error === "invalid_auth") return json(res, out, 401)
      if (out.error) return json(res, out, 502)
      return json(res, out)
    }
    // Teams chat: edit the viewer's OWN message IN-PAGE (t144, ADR-0019). PUT new RichText/Html
    // content; the read path turns properties.edittime into the "(edited)" flag. A 401 → one
    // re-authz + retry → typed invalid_auth. Web only.
    if (p === "/api/teams/edit" && POST) {
      const { convId, msgId, text } = await body(req)
      if (!convId || !msgId || !text?.trim()) return json(res, { error: "missing fields" }, 400)
      const out = await teamsEdit(convId, msgId, text)
      if (out.error === "invalid_auth") return json(res, out, 401)
      if (out.error) return json(res, out, 502)
      return json(res, out)
    }
    // Teams chat: delete the viewer's OWN message IN-PAGE (t144, ADR-0019). DELETE blanks content +
    // sets properties.deletetime, which the read path renders as the tombstone. A 401 → one re-authz
    // + retry → typed invalid_auth. Web only.
    if (p === "/api/teams/delete" && POST) {
      const { convId, msgId } = await body(req)
      if (!convId || !msgId) return json(res, { error: "missing fields" }, 400)
      const out = await teamsDelete(convId, msgId)
      if (out.error === "invalid_auth") return json(res, out, 401)
      if (out.error) return json(res, out, 502)
      return json(res, out)
    }
    // Teams chat: upload a pasted/picked image + post it inline IN-PAGE (t145, ADR-0019). One atomic
    // endpoint: create the AMS object → PUT the bytes → send the AMSImage message. Reads with the
    // larger body cap (a base64 screenshot dwarfs 1 MB). A 401 → one re-authz + retry → typed
    // invalid_auth. Web only.
    if (p === "/api/teams/upload-image" && POST) {
      const { convId, filename, base64, contentType, width, height, text } = await body(
        req,
        IMAGE_BODY_LIMIT,
      )
      if (!convId || !base64) return json(res, { error: "missing fields" }, 400)
      if (contentType && !String(contentType).startsWith("image/"))
        return json(res, { error: "not_image" }, 400)
      const out = await teamsUploadImage({
        convId,
        filename: filename || "image.png",
        base64,
        width,
        height,
        text,
      })
      if (out.error === "invalid_auth") return json(res, out, 401)
      if (out.error) return json(res, out, 502)
      return json(res, out)
    }
    // Teams chat: upload a pasted/picked non-image file to SharePoint + post it as a chip IN-PAGE
    // (t146, ADR-0019). One atomic endpoint: PUT the bytes to the drive → createLink → send the
    // properties.files message. Larger body cap than the image route (files run bigger). A 401 →
    // one re-authz + retry → typed invalid_auth. Web only.
    if (p === "/api/teams/upload-file" && POST) {
      const { convId, filename, base64, text } = await body(req, FILE_BODY_LIMIT)
      if (!convId || !base64) return json(res, { error: "missing fields" }, 400)
      const out = await teamsUploadFile({ convId, filename: filename || "file", base64, text })
      if (out.error === "invalid_auth") return json(res, out, 401)
      if (out.error) return json(res, out, 502)
      return json(res, out)
    }
    // Web Push subscriptions — PWA-installed iOS 16.4+. The public key is non-secret;
    // the client uses it as `applicationServerKey` for pushManager.subscribe.
    if (p === "/api/notifications/vapid-public-key" && !POST) {
      return json(res, { key: VAPID_PUBLIC_KEY })
    }
    if (p === "/api/notifications/subscribe" && POST) {
      const sub = await body(req)
      if (!sub?.endpoint) return json(res, { error: "missing endpoint" }, 400)
      // E0: Reconcile by endpoint. A matching endpoint reuses its stored deviceId (so
      // a storage wipe + re-subscribe on the same device recovers prior per-device prefs);
      // a new endpoint gets a fresh UUID. The renderer adopts the returned id as the
      // single source for device-keyed ui-state.
      const { deviceId } = reconcileDeviceId(pushSubs, sub)
      pushSubs = pushSubs.filter((s) => s.endpoint !== sub.endpoint)
      pushSubs.push({ ...sub, deviceId })
      savePushSubs()
      return json(res, { deviceId })
    }
    if (p === "/api/notifications/unsubscribe" && POST) {
      const { endpoint } = await body(req)
      if (!endpoint) return json(res, { error: "missing endpoint" }, 400)
      pushSubs = pushSubs.filter((s) => s.endpoint !== endpoint)
      savePushSubs()
      return json(res, { ok: true })
    }
    // Teams chat push (t147) — its own isolated subscription store; same VAPID keys, separate subs.
    if (p === "/api/teams/push/vapid-public-key" && !POST) {
      return json(res, { key: VAPID_PUBLIC_KEY })
    }
    if (p === "/api/teams/push/subscribe" && POST) {
      const { subscription, deviceId } = await body(req)
      if (!subscription?.endpoint) return json(res, { error: "missing endpoint" }, 400)
      teamsPushSubs = teamsPushSubs.filter((s) => s.endpoint !== subscription.endpoint)
      teamsPushSubs.push(deviceId ? { ...subscription, deviceId } : subscription)
      saveTeamsPushSubs()
      return json(res, { ok: true })
    }
    if (p === "/api/teams/push/unsubscribe" && POST) {
      const { endpoint } = await body(req)
      if (!endpoint) return json(res, { error: "missing endpoint" }, 400)
      teamsPushSubs = teamsPushSubs.filter((s) => s.endpoint !== endpoint)
      saveTeamsPushSubs()
      return json(res, { ok: true })
    }
  } catch (e) {
    // A malformed/undecryptable body (t099) is a client error → 400, and no route ran, so
    // nothing was persisted. Everything else stays a 500.
    if (e && e.badBody) return json(res, { error: "malformed request body" }, 400)
    return json(res, { error: e.message }, 500)
  }

  if (p.startsWith("/api/")) return res.writeHead(404).end("unknown api route")
  if (p === "/chat" || p.startsWith("/chat/")) return serveChat(req, res, p)
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
    // Liveness for the heartbeat reaper (t099): stamp on connect, on protocol pong, and on any
    // inbound message (the client's 20s app-ping doubles as a liveness signal through proxies
    // that swallow protocol pings).
    ws.__lastPongAt = Date.now()
    ws.on("pong", () => {
      ws.__lastPongAt = Date.now()
    })
    console.log(`[client] ws +1 (now ${wsClients.size})`)
    ws.send(JSON.stringify({ t: "ready" }))
    ws.on("message", async (raw) => {
      ws.__lastPongAt = Date.now()
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
      console.log(`[client] ws -1 (now ${wsClients.size})`)
      // If this was the last supporting client, free the in-flight slot so the next stream
      // (a non-supporting reconnect, or before a new opt-in) isn't blocked by a stale ack.
      if (paintAckClients.delete(ws) && paintAckClients.size === 0) resetPaintAckGate()
    }
    ws.on("close", onWsGone)
    ws.on("error", onWsGone)
  })
})

// Heartbeat reaper (t099): ping every client each interval and terminate + evict one that
// hasn't produced a liveness signal within the deadline — the only way a half-open socket
// (never throws on send) gets cleaned up, freeing its buffered memory and the paint-ack slot.
setInterval(() => {
  for (const ws of wsClients) {
    if (isClientDead(ws.__lastPongAt, Date.now(), WS_PONG_DEADLINE_MS)) {
      try {
        ws.terminate()
      } catch {}
      wsClients.delete(ws)
      if (paintAckClients.delete(ws) && paintAckClients.size === 0) resetPaintAckGate()
      console.log(`[client] ws reaped (dead >${WS_PONG_DEADLINE_MS}ms; now ${wsClients.size})`)
      continue
    }
    try {
      ws.ping()
    } catch {}
  }
}, WS_HEARTBEAT_INTERVAL_MS)

// Surface otherwise-silent async failures in prod logs (greppable [err]) for issue-detection.
process.on("unhandledRejection", (reason) => {
  console.error("[err] unhandledRejection:", reason?.stack || reason)
})

// Graceful shutdown (t099): flush the debounced Slack sweep watermark so a redeploy never
// loses the last ~2s of read progress, then exit. Closes the "no shutdown hook" gap.
let shuttingDown = false
const gracefulShutdown = (sig) => {
  if (shuttingDown) return
  shuttingDown = true
  try {
    sweepStatePersister.flushSync()
  } catch (e) {
    console.error("[web] shutdown flush failed:", e.message)
  }
  console.log(`[web] ${sig} — flushed sweep state, exiting`)
  process.exit(0)
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"))
process.on("SIGINT", () => gracefulShutdown("SIGINT"))

server.listen(PORT, "0.0.0.0", () =>
  console.log(
    `[web] v${APP_VERSION} ${GIT_SHA} http://0.0.0.0:${PORT}  ->  cdp ${host()}:${port()}`,
  ),
)
