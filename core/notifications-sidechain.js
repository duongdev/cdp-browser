// Notification Side-Channel: the whole lifecycle + store in one backend-agnostic
// CJS core. Both main.js (Electron) and web/server.mjs consume it; each supplies
// only effects through DI. A per-target read-only CDP socket (no screencast, no
// Input Forwarding — ADR-0003) attaches to every Notification-Adapter-matching Tab,
// injects the adapter's capture script at document-start, and ingests `__cdpNotify`
// toasts through the shared dedup/cap store. Each stored entry is stamped with
// `entry.adapter` (the matched adapter's name) and fired through `onEntry` once.
//
// Pure helpers (dedup, cap, read-model) come from `notifications.js`; this module
// adds the effectful lifecycle around them. It imports no Electron, no node:http,
// no web-push — every effect arrives through `deps`.

const {
  matchAdapter,
  groupKeyFor,
  slackGroupKey,
  ingest,
  markRead,
  markUnread,
  markAllRead,
  unreadCount,
} = require("./notifications")
const {
  parseLocalConfig,
  pickDCookie,
  groupId,
  markFresh,
  markStale,
  redact,
} = require("./slack-creds")
const { tsCmp } = require("./slack-sweep")

const NOTIFY_BINDING = "__cdpNotify"
const DEFAULT_CAP = 200
// An awaitable side-channel CDP call (cred extraction) gets a timeout so a stalled socket
// frees its promise instead of hanging forever (t096, P4).
const CDP_CALL_TIMEOUT_MS = 10_000
// A side-channel whose target is still live but never reaches OPEN (hung CONNECTING — no open,
// no close, no error) is reaped after this and re-attached on the next reconcile (t096, P3).
// Reconcile runs every ~5s and a healthy local CDP socket opens in well under a second, so a
// still-non-OPEN socket past this threshold is genuinely stuck.
const SIDECHANNEL_STALE_MS = 15_000

// Notification Adapters identify notification-capable sites by URL hostname. Each
// names its capture script (loaded via the injected `readInject`) and the icon to
// stamp on its entries. Adding an adapter is a one-line config change here.
const ADAPTERS = [
  {
    name: "teams",
    script: "teams-notify.js",
    match: (h) => /(^|\.)teams\.(microsoft|cloud\.microsoft)\.com$/.test(h),
    // Served from the app's own origin (t086): external favicon CDNs are blocked by a
    // corporate TLS-intercepting proxy / need auth, so they silently failed to load on the phone.
    iconUrl: "/icons/teams.svg",
  },
  {
    name: "outlook",
    script: "outlook-notify.js",
    match: (h) => /(^|\.)outlook\.(office\.com|live\.com|cloud\.microsoft)$/.test(h),
    iconUrl: "/icons/outlook.svg",
  },
  {
    name: "slack",
    script: "slack-notify.js",
    match: (h) => /(^|\.)slack\.com$/.test(h),
    iconUrl: "/icons/slack.svg",
    // Slack runs every workspace under one origin (app.slack.com), so the default
    // per-origin grouping would merge all workspaces into one badge. Derive the group
    // key from the Tab's URL team id instead — one Tab per workspace, so the URL is the
    // authoritative workspace identity (more durable than the in-page capture script).
    groupKey: slackGroupKey,
    // Slack is the one adapter that also drives a server-side content sweep (ADR-0011).
    // The side-channel extracts the xoxc token + d cookie from a live Slack tab so the
    // server can read authoritative unread state independent of the page firing toasts.
    extractCreds: true,
  },
]

// deps = { readInject, listTargets, load, save, now, WebSocketCtor, onEntry, cap? }
function createNotificationCenter(deps) {
  const { readInject, load, save, WebSocketCtor, onEntry } = deps
  const cap = deps.cap || DEFAULT_CAP

  const adapterFor = (url) => matchAdapter(url, ADAPTERS)
  // Capture-script source is loaded lazily once per adapter and memoized — the same
  // text is reused for every side-channel of that adapter.
  const sourceCache = new Map()
  const sourceFor = (adapter) => {
    if (!sourceCache.has(adapter.name)) sourceCache.set(adapter.name, readInject(adapter.script))
    return sourceCache.get(adapter.name)
  }

  const seeded = load()
  let notifications = Array.isArray(seeded) ? seeded : []
  const persist = () => save(notifications)

  const sideChannels = new Map() // targetId -> ws
  // Slack credential records keyed by teamId (t069). Populated by side-channel extraction;
  // read by the server-side content sweep (t071). Each: { teamId, token, cookie, name, url,
  // enterpriseId, fresh, lastError, selfUserId? }. Creds are the user's own session secrets
  // — never logged in full (see redact).
  const credsByTeam = new Map()
  // Workspaces whose web-API sweep is permanently unsupported (e.g. Enterprise Grid
  // `team_is_restricted`). For these the hijack falls back to writing entries directly,
  // since the sweep can't cover them.
  const sweepDisabledTeams = new Set()
  const log = deps.log || (() => {})
  const now = deps.now || (() => Date.now())
  const WS_OPEN = WebSocketCtor && WebSocketCtor.OPEN != null ? WebSocketCtor.OPEN : 1

  function recordCreds(team, cookie) {
    const prev = credsByTeam.get(team.teamId) || {}
    const rec = markFresh(prev, {
      teamId: team.teamId,
      token: team.token,
      cookie,
      name: team.name,
      url: team.url,
      enterpriseId: team.enterpriseId,
    })
    credsByTeam.set(team.teamId, rec)
    log(`[slack-creds] extracted ${team.teamId} (${team.name}) token=${redact(team.token)}`)
    if (deps.onCreds) deps.onCreds(rec)
  }

  // The groupKey for an adapter's entry derived from the Tab URL. For Slack it resolves the
  // URL teamId to its merged Enterprise Grid groupId (t092) via the extracted cred record
  // (which carries enterpriseId) so a hijack-fallback entry buckets with the org's swept ones;
  // a standalone team (no cred / no enterpriseId) keeps its own teamId. Non-Slack adapters
  // fall through to their own groupKey hook (or null).
  function slackFallbackGroupKey(adapter, url) {
    if (!adapter || !adapter.groupKey) return null
    if (adapter.name !== "slack") return adapter.groupKey(url)
    const teamId = slackGroupKey(url)?.replace(/^slack:/, "")
    if (!teamId) return adapter.groupKey(url)
    const cred = credsByTeam.get(teamId)
    return `slack:${groupId(cred) || teamId}`
  }

  function handleToast(raw, target) {
    let n
    try {
      n = JSON.parse(raw)
    } catch {
      return
    }
    if (!n || typeof n !== "object") return
    const adapter = adapterFor(target.url)
    // Slack with the sweep active (ADR-0011): the hijack no longer writes store entries
    // (the sweep is the authoritative, message-anchored writer). It instead acts as an
    // instant "sweep now" trigger so a real event is delivered in ~1s via the sweep —
    // sub-second latency without the fuzzy hijack↔sweep dedup we deferred. EXCEPTION: a
    // workspace whose sweep is unsupported (Enterprise Grid `team_is_restricted`) falls
    // through to storing the hijack entry directly, so it isn't lost.
    if (adapter && adapter.name === "slack" && deps.onSlackSignal) {
      const teamId = slackGroupKey(target.url)?.replace(/^slack:/, "")
      if (teamId && !sweepDisabledTeams.has(teamId)) {
        deps.onSlackSignal(teamId)
        return
      }
      // else: fall through to normal ingest (sweep can't cover this workspace).
    }
    const { list, entry } = ingest(
      notifications,
      {
        id: n.id,
        adapter: adapter ? adapter.name : null,
        // Stable grouping key — an adapter's URL-derived key (e.g. Slack's per-workspace
        // `slack:{teamId}`) wins; else the capture script's explicit groupKey, else the
        // Tab's URL origin (today's per-origin grouping). Consumers key on this, never origin.
        // Slack hijack fallback: resolve the URL teamId to its merged Enterprise Grid groupId
        // (slack:{groupId}, t092) so a fully-unsupported Grid member's entry buckets with its
        // org pseudo-team's swept entries instead of reintroducing a duplicate.
        groupKey: slackFallbackGroupKey(adapter, target.url) || groupKeyFor(n, target.url),
        source: n.source || "",
        title: n.title || "",
        body: n.body || "",
        targetId: target.id,
        targetUrl: target.url,
        // Normalized deep-open intent (semantic ids only). Pass through untouched; the
        // renderer's activation registry dispatches it. Legacy targetEntity stays for
        // back-compatible display.
        activate: n.activate || null,
        targetEntity: n.targetEntity || null,
        icon: (adapter || {}).iconUrl || null,
        ts: n.ts || (deps.now ? deps.now() : Date.now()),
      },
      cap,
    )
    if (!entry) return // rejected: missing id or duplicate (cross-tab / headless+client safe)
    notifications = list
    persist()
    onEntry(entry)
  }

  function attach(target) {
    const adapter = adapterFor(target.url)
    if (!adapter || !target.webSocketDebuggerUrl) return
    const ws = new WebSocketCtor(target.webSocketDebuggerUrl)
    ws.__attachedAt = now()
    sideChannels.set(target.id, ws)
    let cmdId = 1
    // Fire-and-forget CDP send (capture-script injection doesn't need the reply).
    const cdp = (method, params) =>
      ws.send(JSON.stringify({ id: cmdId++, method, params: params || {} }))
    // Awaitable CDP call — cred extraction needs the evaluate/getCookies results, so it
    // correlates the reply by command id through `pending`. A timeout rejects a call whose
    // reply never arrives (stalled socket), and `drop` rejects any in-flight call on
    // close/error — so a dead socket never leaves a promise hanging (t096, P4).
    const pending = new Map()
    const cdpCall = (method, params) =>
      new Promise((resolve, reject) => {
        const id = cmdId++
        const timer = setTimeout(() => {
          if (pending.delete(id)) reject(new Error(`cdp ${method} timed out`))
        }, CDP_CALL_TIMEOUT_MS)
        pending.set(id, {
          resolve: (v) => {
            clearTimeout(timer)
            resolve(v)
          },
          reject: (e) => {
            clearTimeout(timer)
            reject(e)
          },
        })
        ws.send(JSON.stringify({ id, method, params: params || {} }))
      })
    ws.on("open", () => {
      cdp("Runtime.enable")
      cdp("Page.enable")
      cdp("Runtime.addBinding", { name: NOTIFY_BINDING })
      // document-start for future loads + the already-loaded document.
      cdp("Page.addScriptToEvaluateOnNewDocument", { source: sourceFor(adapter) })
      cdp("Runtime.evaluate", { expression: sourceFor(adapter) })
      // Slack only: pull the workspace creds for the server-side sweep (ADR-0011).
      if (adapter.extractCreds && deps.onCreds) {
        extractSlackCreds(cdpCall, target).catch(() => {})
      }
    })
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.id != null && pending.has(msg.id)) {
          pending.get(msg.id).resolve(msg)
          pending.delete(msg.id)
          return
        }
        if (msg.method === "Runtime.bindingCalled" && msg.params.name === NOTIFY_BINDING) {
          handleToast(msg.params.payload, target)
        }
      } catch {}
    })
    const drop = () => {
      if (sideChannels.get(target.id) === ws) sideChannels.delete(target.id)
      // Free any in-flight awaitable call so a stalled socket can't leak its promise.
      for (const p of pending.values()) p.reject(new Error("side-channel closed"))
      pending.clear()
    }
    ws.on("close", drop)
    ws.on("error", drop)
  }

  // Read the xoxc tokens (localConfig_v2) + the shared `d` session cookie off a live Slack
  // tab and record one cred entry per signed-in workspace. Best-effort: a parse miss or a
  // CDP error leaves any prior creds intact and logs — never throws into the attach path.
  async function extractSlackCreds(cdpCall, target) {
    try {
      const evalRes = await cdpCall("Runtime.evaluate", {
        expression: "localStorage.localConfig_v2 || ''",
        returnByValue: true,
      })
      const raw = evalRes?.result?.result?.value
      const { teams } = parseLocalConfig(raw)
      if (!teams.length) return
      const cookieRes = await cdpCall("Network.getCookies", {
        urls: ["https://app.slack.com", ...teams.map((t) => t.url).filter(Boolean)],
      })
      const cookie = pickDCookie(cookieRes?.result?.cookies)
      if (!cookie) {
        log(`[slack-creds] no d cookie on ${target.url}`)
        return
      }
      for (const team of teams) recordCreds(team, cookie)
    } catch (e) {
      log(`[slack-creds] extraction failed: ${e && e.message ? e.message : e}`)
    }
  }

  // Attach to newly-seen adapter-matching Tab targets, drop vanished/changed ones.
  // `targets` is optional; when omitted, the injected `listTargets()` is called.
  async function reconcile(targets) {
    let list = targets
    if (!Array.isArray(list)) {
      try {
        list = await deps.listTargets()
      } catch {
        return
      }
    }
    if (!Array.isArray(list)) return
    const matched = list.filter((t) => t.type === "page" && adapterFor(t.url))
    const liveIds = new Set(matched.map((t) => t.id))
    for (const [id, ws] of sideChannels) {
      // Reap a vanished/changed target's socket, OR a socket on a still-live target that is
      // stuck below OPEN past the stale threshold (hung CONNECTING — no open/close/error fires,
      // so it would otherwise sit unreaped and unre-attached; t096, P3).
      const stale =
        liveIds.has(id) &&
        ws.readyState !== WS_OPEN &&
        now() - (ws.__attachedAt || 0) > SIDECHANNEL_STALE_MS
      if (!liveIds.has(id) || stale) {
        try {
          ws.close()
        } catch {}
        sideChannels.delete(id)
      }
    }
    for (const t of matched) if (!sideChannels.has(t.id)) attach(t)
  }

  return {
    adapterFor,
    reconcile,
    list: () => notifications,
    markRead: (id) => {
      notifications = markRead(notifications, id)
      persist()
      return notifications
    },
    markUnread: (id) => {
      notifications = markUnread(notifications, id)
      persist()
      return notifications
    },
    markAllRead: () => {
      notifications = markAllRead(notifications)
      persist()
      return notifications
    },
    clear: () => {
      notifications = []
      persist()
      return notifications
    },
    // Remove a specific set of entries by id — backs the group-level "clear conversation"
    // action (t085). The renderer collects every id in a conversation group (including the
    // collapsed ones) and posts them, so one tap dismisses the whole channel/thread.
    removeMany: (ids) => {
      const drop = new Set(ids || [])
      if (drop.size) notifications = notifications.filter((n) => !drop.has(n.id))
      persist()
      return notifications
    },
    unreadCount: () => unreadCount(notifications),
    // Slack cred accessors (t069) — the server-side sweep (t071) reads these.
    listCreds: () => [...credsByTeam.values()],
    getCreds: (teamId) => credsByTeam.get(teamId) || null,
    // Mark a workspace's creds stale (e.g. the sweep got a 401) so the health surface
    // (t074) can flag it and the parked-tab keeper (t070) re-extracts. Keeps the last creds.
    markCredsStale: (teamId, reason) => {
      const prev = credsByTeam.get(teamId)
      if (prev) credsByTeam.set(teamId, markStale(prev, reason))
    },
    // The sweep caches the resolved self user id (for channel @-mention parity) here.
    setSelfUserId: (teamId, selfUserId) => {
      const prev = credsByTeam.get(teamId)
      if (prev) credsByTeam.set(teamId, { ...prev, selfUserId })
    },
    // Permanently disable the sweep for a workspace (e.g. Grid `team_is_restricted`) so the
    // hijack stores its notifications directly. Also stamped on the cred record for t074.
    disableSweep: (teamId, reason) => {
      sweepDisabledTeams.add(teamId)
      const prev = credsByTeam.get(teamId)
      if (prev) credsByTeam.set(teamId, { ...prev, sweepUnsupported: reason || true })
    },
    isSweepDisabled: (teamId) => sweepDisabledTeams.has(teamId),
    // The Slack content sweep (t071) is the authoritative writer of Slack entries. It feeds
    // already-shaped store entries (decorated by the runner) through the same dedup/cap/
    // onEntry pipeline the hijack used — so broadcast + Web Push fire exactly once per entry,
    // and the stable slack:{team}:{channel}:{ts} id makes re-runs idempotent.
    ingestSlackEntry: (payload) => {
      const { list, entry } = ingest(notifications, payload, cap)
      if (!entry) return null
      notifications = list
      persist()
      onEntry(entry)
      return entry
    },
    // Restricted-path read-sync (t075): users.counts gives no last_read, so mark read any
    // swept entry (for this group) whose channel is no longer in the unread set. Coarser than
    // per-message last_read but correct: a conversation with zero unreads is fully read.
    // Keyed by the merged group id (slack:{groupId}, t092) — the runner passes the groupId so
    // this matches the groupKey the sweep stamps on entries (an Enterprise Grid member's
    // physical teamId would never match its org's groupId-keyed entries).
    applySlackReadByUnread: (groupId, unreadChannelSet) => {
      const groupKey = `slack:${groupId}`
      let changed = false
      const updated = notifications.map((e) => {
        if (e.read || e.groupKey !== groupKey || !e.channelId) return e
        if (!unreadChannelSet.has(e.channelId)) {
          changed = true
          return { ...e, read: true }
        }
        return e
      })
      if (changed) {
        notifications = updated
        persist()
      }
      return notifications
    },
    // Follow Slack last_read: flip swept entries (those carrying a slackTs + channelId) to
    // read when their channel's last_read advances past them — keeps badges honest across
    // all clients. Compares the original Slack ts (slackTs), not the ms-epoch display ts.
    applySlackReadUpdates: (lastReadByChannel) => {
      let changed = false
      const updated = notifications.map((e) => {
        if (e.read || !e.channelId || !e.slackTs) return e
        const lr = lastReadByChannel[e.channelId]
        if (lr && tsCmp(e.slackTs, lr) <= 0) {
          changed = true
          return { ...e, read: true }
        }
        return e
      })
      if (changed) {
        notifications = updated
        persist()
      }
      return notifications
    },
    close: () => {
      for (const [, ws] of sideChannels) {
        try {
          ws.close()
        } catch {}
      }
      sideChannels.clear()
    },
  }
}

module.exports = { createNotificationCenter, ADAPTERS, NOTIFY_BINDING }
