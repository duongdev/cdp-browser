/**
 * Web runtime shim. In the browser there is no Electron preload, so this builds a
 * `window.cdp` that speaks the same `CdpBridge` contract over plain HTTP: POST for
 * commands, an `EventSource` (SSE) for server pushes, and a coalescing batcher so
 * high-frequency input/acks don't become one POST each. It also installs a no-op
 * `window.local` (local tabs/extensions are Electron-only) and a capability object
 * the UI reads to hide those affordances.
 *
 * Installed by `src/main.tsx` only when `window.cdp` is absent (i.e. not Electron).
 * The renderer is otherwise transport-agnostic — see the Transport seam in
 * remote-page.ts. See docs/tasks/008.
 */

import { type Batch, createBatcher, createHoverGate, createSingleFlight } from "./input-coalesce"
import { perfMark } from "./perf-mark"
import { createTransportSelector, type InputTransportMode } from "./transport-selector"

export interface WebCaps {
  /** True in the browser build. */
  web: boolean
  /** Local <webview> tabs — Electron only. */
  localTabs: boolean
  /** Unpacked MV3 extensions — Electron only. */
  extensions: boolean
}

const DEFAULT_CAPS: WebCaps = { web: true, localTabs: false, extensions: false }

export function getCaps(): WebCaps {
  return (
    (typeof window !== "undefined" && window.webCaps) || {
      web: false,
      localTabs: true,
      extensions: true,
    }
  )
}

type Cmd = { method: string; params?: unknown }

const isMouseMove = (c: Cmd) =>
  c.method === "Input.dispatchMouseEvent" &&
  (c.params as { type?: string } | undefined)?.type === "mouseMoved"

// Merge for the POST fallback: collapse runs of consecutive mouseMoved to the latest
// (only the current cursor position matters once we're behind), while clicks, wheel,
// and keys break a run and are preserved in order.
export function collapseMoves(items: Cmd[]): Cmd[] {
  const out: Cmd[] = []
  for (const c of items) {
    const prev = out[out.length - 1]
    if (isMouseMove(c) && prev && isMouseMove(prev)) out[out.length - 1] = c
    else out.push(c)
  }
  return out
}

// When E2E is on (set during bootstrap), every /api body + SSE frame is sealed under
// this key; otherwise null and everything is plaintext (as before). See t012.
import { deriveKey as envDeriveKey, open as envOpen, seal as envSeal } from "./crypto-envelope"

let e2eKey: CryptoKey | null = null
const E2E_PASS_STORE = "cdp-e2e-pass"

async function getJson(path: string) {
  const res = await fetch(path)
  if (e2eKey) return envOpen(await res.text(), e2eKey)
  return res.json()
}
async function postJson(path: string, body?: unknown) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": e2eKey ? "text/plain" : "application/json" },
    body: e2eKey ? await envSeal(body ?? {}, e2eKey) : JSON.stringify(body ?? {}),
  })
  if (res.status === 204) return undefined
  if (e2eKey) return envOpen(await res.text(), e2eKey)
  return res.json()
}
// Raw POST of an already-serialized line (sealed envelope or JSON) — the server's body()
// opens/parses it. Used by the input fallback so a sealed batch posts verbatim.
async function postRaw(path: string, line: string) {
  await fetch(path, { method: "POST", headers: { "Content-Type": "text/plain" }, body: line })
}

// Chrome/Edge can stream a request body (ReadableStream + duplex:'half') over HTTP/2.
// Detection per the documented pattern: duplex is read and no Content-Type is auto-set.
const SUPPORTS_REQUEST_STREAMING = (() => {
  if (typeof ReadableStream === "undefined" || typeof Request === "undefined") return false
  try {
    let duplexAccessed = false
    const hasContentType = new Request("http://x", {
      body: new ReadableStream(),
      method: "POST",
      get duplex() {
        duplexAccessed = true
        return "half"
      },
      // biome-ignore lint/suspicious/noExplicitAny: duplex not yet in lib.dom RequestInit
    } as any).headers.has("Content-Type")
    return duplexAccessed && !hasContentType
  } catch {
    return false
  }
})()

/**
 * The low-latency input path: one long-lived POST whose body streams NDJSON frames,
 * so input flushes don't each pay a fresh request's TLS/auth/RTT through the proxy
 * chain. Pairs with the SSE down-channel — no WebSocket. See t011.
 *
 * Safety: a buffering proxy (Authentik/openresty without `proxy_request_buffering off`)
 * would accept the stream but never deliver the body — input would vanish. So on open we
 * send a `probe` frame and only switch real input onto the stream once the server echoes
 * a `stream-ack` over SSE. Until confirmed (and forever, if the probe is never acked) we
 * use a per-flush POST. `notifyAck()` is called by the SSE `stream-ack` handler.
 */
function createInputChannel(postFallback: (batch: Batch<Cmd>) => void) {
  const enc = new TextEncoder()
  // Give up after this many establish attempts that never get acked (no HTTP/2, or a
  // buffering proxy) and stay on the POST fallback for good — don't loop forever.
  const MAX_ATTEMPTS = 2
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null
  let abort: AbortController | null = null
  let state: "idle" | "probing" | "streaming" | "blocked" = "idle"
  let attempts = 0
  let watchdog: ReturnType<typeof setTimeout> | null = null

  function onSettle() {
    if (watchdog) {
      clearTimeout(watchdog)
      watchdog = null
    }
    controller = null
    if (state === "blocked") return
    const wasStreaming = state === "streaming" // dropped after working ⇒ transient
    state = "idle"
    if (wasStreaming) attempts = 0
    else if (attempts >= MAX_ATTEMPTS) {
      state = "blocked"
      return
    }
    setTimeout(open, 1000)
  }

  function open() {
    if (!SUPPORTS_REQUEST_STREAMING || state !== "idle") return
    state = "probing"
    attempts++
    abort = new AbortController()
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c
        c.enqueue(enc.encode(`${JSON.stringify({ probe: 1 })}\n`))
      },
    })
    // Resolves only when the body closes (half-duplex) — we never close it, so settling
    // means the channel dropped. Replies (incl. the probe ack) arrive over SSE.
    fetch("/api/input-stream", {
      method: "POST",
      body,
      signal: abort.signal,
      duplex: "half",
      // biome-ignore lint/suspicious/noExplicitAny: duplex not yet in lib.dom RequestInit
    } as any)
      .catch(() => {})
      .finally(onSettle)
    // No ack in the window ⇒ a buffering proxy swallowed the body (fetch hangs) ⇒ abort
    // so onSettle counts the failed attempt and eventually falls back permanently.
    watchdog = setTimeout(() => {
      if (state === "probing") abort?.abort()
    }, 3000)
  }
  open()

  return {
    send(batch: Batch<Cmd>) {
      if (state === "streaming" && controller) {
        try {
          controller.enqueue(enc.encode(`${JSON.stringify(batch)}\n`))
          return
        } catch {
          state = "idle"
        }
      }
      postFallback(batch)
    },
    notifyAck() {
      if (state === "probing") {
        if (watchdog) {
          clearTimeout(watchdog)
          watchdog = null
        }
        attempts = 0
        state = "streaming"
      }
    },
  }
}

/**
 * Optional WebSocket channel (t019). When connected and ready, all CDP traffic — events
 * in, invokes/sends/batches out — rides one full-duplex socket instead of SSE+POST.
 * The picker in settings selects between Auto/Fastest(WS)/Streaming/Basic; this channel
 * is the "Fastest" path and the head of the Auto fallback chain. Returns a thin handle
 * the rest of createWebCdp consults via `ws.ready()` before falling back.
 */
function createWsChannel(opts: {
  onEvent: (event: string, data: string) => void
  /** Fast path for screencast: a text "cdp-frame" envelope pairs with a binary WS frame
   *  carrying raw JPEG bytes. Skips base64 + the JSON.parse of a 250KB envelope on the
   *  renderer main thread. The caller forges a CDP event with `dataBlob` populated and
   *  dispatches through the normal CDP event listeners. */
  onFrameBinary?: (cdpMsg: {
    method: string
    params: Record<string, unknown> & { dataBlob: Blob }
  }) => void
  onReady: () => void
  onClose: () => void
}) {
  let socket: WebSocket | null = null
  let ready = false
  // Pending awaited invokes keyed by id; the server echoes the id in invoke-result.
  let nextId = 1
  const pending = new Map<number, (result: unknown) => void>()
  // True when the outer asked us to close — suppresses the onClose callback so a stale
  // socket's late `close` event doesn't clobber a newly-opened channel's outer state.
  let suppressClose = false

  function open() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:"
    const url = `${proto}//${location.host}/api/ws`
    try {
      socket = new WebSocket(url)
    } catch {
      opts.onClose()
      return
    }
    // The binary frame fast path: server sends a text "cdp-frame" envelope first
    // (containing metadata + sessionId) then the raw JPEG bytes as the next WS message.
    // Delivering as Blob is faster than ArrayBuffer for createImageBitmap — no extra copy.
    socket.binaryType = "blob"
    let pendingFrame: { method: string; params: Record<string, unknown> } | null = null
    socket.onmessage = async (ev) => {
      // Binary message → pair with the preceding "cdp-frame" envelope.
      if (ev.data instanceof Blob) {
        if (!pendingFrame) return // out-of-order binary, drop
        const frame = pendingFrame
        pendingFrame = null
        opts.onFrameBinary?.({
          method: frame.method,
          params: { ...frame.params, dataBlob: ev.data },
        })
        return
      }
      // Envelope is always plaintext JSON (the `t` field is routing metadata, like SSE
      // event names). For event messages, `data` is the sealed CDP payload that onSse()
      // unwraps. For invoke-result, the server passes the CDP invoke output through plain
      // — these are server-generated, not user content.
      const tEntry = performance.now() // [DEBUG-perf]
      const text = ev.data as string
      const tParse = performance.now() // [DEBUG-perf]
      let msg: { t: string; event?: string; data?: unknown; id?: number; result?: unknown }
      try {
        msg = JSON.parse(text)
      } catch {
        return
      }
      // [DEBUG-perf] Only mark big-payload events (the cdp screencast frames) so we measure
      // the actual bottleneck and not all the tiny notification envelopes.
      if (msg.t === "event" && msg.event === "cdp" && text.length > 5000) {
        perfMark("wsRecv", tParse - tEntry)
        perfMark("jsonParse", performance.now() - tParse)
      }
      if (msg.t === "ready") {
        ready = true
        opts.onReady()
      } else if (msg.t === "event" && msg.event === "cdp-frame") {
        // Stash metadata; the next binary message is the JPEG bytes for this frame.
        pendingFrame = msg.data as { method: string; params: Record<string, unknown> }
      } else if (msg.t === "event" && msg.event && msg.data !== undefined) {
        opts.onEvent(msg.event, msg.data as string)
      } else if (msg.t === "invoke-result" && typeof msg.id === "number") {
        const cb = pending.get(msg.id)
        pending.delete(msg.id)
        // Result is sealed under E2E (the routing envelope around it stays plaintext).
        const result = e2eKey ? await envOpen(msg.result as string, e2eKey) : msg.result
        cb?.(result)
      }
    }
    socket.onclose = () => {
      ready = false
      socket = null
      pending.forEach((cb) => cb({ error: "ws closed" }))
      pending.clear()
      if (suppressClose) return // caller already handled the outer state on explicit close
      opts.onClose()
    }
    socket.onerror = () => {
      try {
        socket?.close()
      } catch {}
    }
  }

  async function rawSend(payload: unknown) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false
    const text = e2eKey ? await envSeal(payload, e2eKey) : JSON.stringify(payload)
    try {
      socket.send(text)
      return true
    } catch {
      return false
    }
  }

  open()

  return {
    isReady: () => ready,
    close: () => {
      suppressClose = true
      socket?.close()
    },
    send: (method: string, params?: unknown) => rawSend({ t: "send", method, params }),
    batch: (items: Cmd[]) => rawSend({ t: "batch", items }),
    invoke: (method: string, params?: unknown) =>
      new Promise<unknown>((resolve) => {
        const id = nextId++
        pending.set(id, resolve)
        void rawSend({ t: "invoke", id, method, params }).then((ok) => {
          if (!ok) {
            pending.delete(id)
            resolve({ error: "ws send failed" })
          }
        })
      }),
  }
}

function createWebCdp(): CdpBridge {
  // SSE: one stream carries every server push; fan out to registered listeners.
  const listeners = {
    event: [] as ((msg: unknown) => void)[],
    disconnected: [] as (() => void)[],
    notification: [] as ((e: CdpNotification) => void)[],
    notificationActivate: [] as ((e: CdpNotification) => void)[],
    nativeTheme: [] as ((isDark: boolean) => void)[],
  }

  // Mode selection (t019). User pref from localStorage controls what's attempted; the
  // actual active mode is derived from runtime state (wsReady? streamReady? else batch).
  // The picker writes the pref and triggers reconfigureMode() to apply mid-session.
  const VALID_MODES: InputTransportMode[] = ["auto", "ws", "stream", "batch"]
  function readMode(): InputTransportMode {
    if (typeof localStorage === "undefined") return "auto"
    const raw = localStorage.getItem("inputTransport")
    // Validate against the union — a stale or hand-edited value falls back to auto rather
    // than silently shaping subsequent branches (e.g. wsAllowed) with garbage.
    return raw && (VALID_MODES as string[]).includes(raw) ? (raw as InputTransportMode) : "auto"
  }
  let wantMode: InputTransportMode = readMode()
  const selector = createTransportSelector({
    cache:
      typeof localStorage !== "undefined"
        ? localStorage
        : { getItem: () => null, setItem: () => {} },
  })
  let wsReady = false
  let ws: ReturnType<typeof createWsChannel> | null = null
  // Active-mode tracking: what the runtime actually settled on (vs. what the user picked).
  // Emits to UI listeners so the settings badge can show "Active: …" when Auto downgrades.
  let activeMode: InputTransportMode = "batch"
  const activeModeListeners: ((m: InputTransportMode) => void)[] = []
  function setActiveMode(m: InputTransportMode) {
    if (m === activeMode) return
    activeMode = m
    for (const cb of activeModeListeners) cb(m)
  }
  function deriveActiveMode() {
    if (wsReady) return "ws" as const
    // streamingActive is set by the inputChannel's notifyAck path, below.
    if (streamingActive) return "stream" as const
    return "batch" as const
  }
  let streamingActive = false

  // SSE is the events fallback when WS is unavailable. The lifecycle is mutable so we can
  // close it once WS is confirmed ready (avoiding the server double-broadcasting frames to
  // both channels — the SSE bytes were arriving and being discarded, costing real bandwidth
  // on iPad PWA where the screencast already saturates the decode loop).
  let es: EventSource = new EventSource("/api/events")
  function teardownSse() {
    try {
      es.close()
    } catch {}
  }
  function reopenSse() {
    es = new EventSource("/api/events")
    attachSseListeners(es)
  }
  // Decode an SSE data payload (plaintext JSON, or a sealed envelope under E2E). When
  // sealed, decode is async — serialize through one chain so frame/event order holds.
  let sseChain: Promise<unknown> = Promise.resolve()
  // biome-ignore lint/suspicious/noExplicitAny: demuxed CDP/notification payloads are dynamic
  function onSse(data: string, fire: (msg: any) => void) {
    if (!e2eKey) {
      fire(JSON.parse(data))
      return
    }
    const key = e2eKey
    sseChain = sseChain.then(async () => fire(await envOpen(data, key)))
  }
  function attachSseListeners(src: EventSource) {
    src.addEventListener("cdp", (e) => {
      if (wsReady) return // WS carries CDP events; SSE is fallback only (we also close it).
      onSse((e as MessageEvent).data, (msg) => {
        if (isFilteredCdpEvent(msg)) return // tunnel delivers screencast frames
        for (const cb of listeners.event) cb(msg)
      })
    })
    src.addEventListener("disconnected", () => {
      for (const cb of listeners.disconnected) cb()
    })
    src.addEventListener("notification", (e) =>
      onSse((e as MessageEvent).data, (entry) => {
        for (const cb of listeners.notification) cb(entry)
        maybeToast(entry)
      }),
    )
    src.addEventListener("notification-activate", (e) =>
      onSse((e as MessageEvent).data, (entry) => {
        for (const cb of listeners.notificationActivate) cb(entry)
      }),
    )
    src.addEventListener("stream-ack", () => {
      // streaming input ack lives in the non-E2E batcher branch below; the variable is
      // hoisted to module-local closure so this listener can find the same instance after
      // the SSE is torn down + reopened on WS drop.
      if (inputChannelRef) {
        inputChannelRef.notifyAck()
        streamingActive = true
        setActiveMode(deriveActiveMode())
      }
    })
  }
  // Forward-declared so attachSseListeners can reach the input channel after it's built.
  let inputChannelRef: { notifyAck(): void } | null = null
  attachSseListeners(es)

  // Web Push: the service worker fires `notificationclick` and posts a message into the
  // page. The data carries enough to deep-link the conversation without re-fetching, so
  // the same notificationActivate listeners that handle in-app clicks fire here too.
  if (typeof navigator !== "undefined" && navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener("message", (event) => {
      const msg = event.data
      if (!msg || msg.type !== "notification-click" || !msg.data) return
      const entry: CdpNotification = {
        id: msg.data.id,
        source: "",
        title: "",
        body: "",
        targetId: msg.data.targetId,
        targetUrl: msg.data.targetUrl,
        targetEntity: msg.data.targetEntity,
        ts: Date.now(),
        read: false,
      }
      for (const cb of listeners.notificationActivate) cb(entry)
    })
  }

  // OS toast via the web Notification API — the browser-side stand-in for the Electron
  // Notification main fired. Opt-in: gated by the `webPush` setting (the "Push
  // notifications" toggle handles the permission grant), only when the tab isn't
  // visible, and only with permission granted. Clicking re-focuses and routes through
  // the same notification-activate listeners the renderer registers.
  let webPush = false
  function maybeToast(entry: CdpNotification) {
    if (!webPush) return
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return
    if (typeof document !== "undefined" && document.visibilityState === "visible") return
    const n = new Notification(entry.title || entry.source, {
      body: entry.body,
      icon: entry.icon || undefined,
    })
    n.onclick = () => {
      window.focus()
      for (const cb of listeners.notificationActivate) cb(entry)
      n.close()
    }
  }

  // WS open is re-callable so the picker can apply mid-session (close, switch mode, retry).
  // If WS opens, frames + events arrive via WS and the batcher uses WS; if it fails or the
  // user picked a slower mode, the existing SSE+POST/stream paths handle everything.
  function openWs() {
    if (typeof WebSocket === "undefined") return
    if (ws) return // already attempting / open
    ws = createWsChannel({
      onFrameBinary: (cdpMsg) => {
        if (isFilteredCdpEvent(cdpMsg)) return // tunnel delivers screencast frames
        // Forge a synthetic Page.screencastFrame event with the Blob attached, then
        // dispatch through the same CDP event listeners the JSON path uses. The viewport
        // looks for `dataBlob` first (fast createImageBitmap decode), else falls back to
        // the legacy `data` base64 string.
        for (const cb of listeners.event) cb(cdpMsg)
      },
      onEvent: (event, data) => {
        if (event === "cdp")
          onSse(data, (msg) => {
            if (isFilteredCdpEvent(msg)) return
            listeners.event.forEach((cb) => cb(msg))
          })
        else if (event === "disconnected") listeners.disconnected.forEach((cb) => cb())
        else if (event === "notification")
          onSse(data, (entry) => {
            listeners.notification.forEach((cb) => cb(entry as CdpNotification))
            maybeToast(entry as CdpNotification)
          })
        else if (event === "notification-activate")
          onSse(data, (entry) =>
            listeners.notificationActivate.forEach((cb) => cb(entry as CdpNotification)),
          )
      },
      onReady: () => {
        wsReady = true
        selector.recordRetry("ws", true)
        // Coming back from a degraded state — clear it so onFocus doesn't re-trigger.
        if (selector.isDegraded()) selector.clearDegraded()
        // Server now broadcasts every event to WS too — close SSE to stop the duplicate
        // frame stream that was costing real bandwidth (esp. iPad PWA where the screencast
        // decode loop is the bottleneck).
        teardownSse()
        setActiveMode(deriveActiveMode())
      },
      onClose: () => {
        const wasReady = wsReady
        wsReady = false
        ws = null
        if (!wasReady) {
          // Probe failed. In auto, downgrade; in manual ws, flag the user-visible error.
          selector.recordRetry("ws", false)
          if (wantMode === "ws") selector.recordFailure("ws")
          else if (wantMode === "auto" && selector.shouldDowngrade("ws"))
            selector.recordDowngrade("ws", "stream")
        }
        // SSE was closed when WS came up; reopen it so events keep flowing while we're
        // off WS (whether dropped or user-toggled to Streaming/Basic).
        if (wasReady) reopenSse()
        setActiveMode(deriveActiveMode())
      },
    })
  }
  function closeWs() {
    if (ws) {
      const wasReady = wsReady
      ws.close() // suppresses the createWsChannel onClose callback
      ws = null
      wsReady = false
      // If WS had been ready, SSE was torn down on its onReady — bring it back so events
      // flow while we're off WS. (If WS hadn't reached ready, SSE was never closed.)
      if (wasReady) reopenSse()
    }
  }
  function shouldOpenWs(m: InputTransportMode): boolean {
    return m === "auto" || m === "ws"
  }
  if (shouldOpenWs(wantMode)) openWs()

  // Batch input + acks: coalesce moves, accumulate wheel, flush discrete immediately.
  // Non-E2E: write each batch as an NDJSON frame to the streaming channel (low latency),
  // falling back to a per-batch POST. E2E: skip streaming (the probe/async-seal/order
  // interplay isn't worth it) and post each sealed batch in order to /api/cdp-batch.
  // When WS is ready, all batches ride the WS instead — same envelope { t: "batch" }.
  let batcher: ReturnType<typeof createBatcher<Cmd>>
  if (e2eKey) {
    const key = e2eKey
    let chain: Promise<unknown> = Promise.resolve()
    batcher = createBatcher<Cmd>({
      schedule: (flush) => requestAnimationFrame(flush),
      send: (batch: Batch<Cmd>) => {
        // Prefer WS when ready (one socket, no per-batch TLS/auth); else seal-and-POST.
        if (wsReady && ws) {
          void ws.batch(batch.items)
          return
        }
        chain = chain.then(async () => postRaw("/api/cdp-batch", await envSeal(batch, key)))
      },
    })
  } else {
    // Fallback (no streaming channel): single-flight POSTs with move-collapsing so a
    // high-RTT proxy chain can't back up — at most one /api/cdp-batch in flight, latest
    // cursor position wins. The streaming path bypasses this (it's already low-latency).
    const fallback = createSingleFlight<Cmd>({
      merge: collapseMoves,
      post: (items) => postRaw("/api/cdp-batch", JSON.stringify({ items })),
    })
    const inputChannel = createInputChannel((batch) => fallback.push(batch.items))
    // Hand the inputChannel to the SSE listener registered in attachSseListeners — that's
    // the only place stream-ack is wired, so it survives SSE close+reopen on WS bounce.
    inputChannelRef = inputChannel
    batcher = createBatcher<Cmd>({
      schedule: (flush) => requestAnimationFrame(flush),
      send: (batch: Batch<Cmd>) => {
        if (wsReady && ws) {
          void ws.batch(batch.items)
          return
        }
        // In "batch" mode the user has explicitly opted out of streaming; force the POST
        // fallback even if the stream channel later acks (the inputChannel itself keeps
        // probing — cheap — but we don't route batches through it).
        if (wantMode === "batch") {
          fallback.push(batch.items)
          return
        }
        inputChannel.send(batch)
      },
    })
  }

  // Hover (buttons-up) moves stream nothing until the cursor stops, then send one resting
  // position — a continuous hover otherwise floods the transport and starves clicks. Drag
  // moves bypass the gate (they carry held buttons) so selection / drag-n-drop track live.
  const HOVER_STOP_MS = 80
  const hover = createHoverGate<Cmd>({
    delay: (cb) => {
      const t = setTimeout(cb, HOVER_STOP_MS)
      return () => clearTimeout(t)
    },
    emit: (cmd) => batcher.coalesce(cmd),
  })

  // Direct-frame tunnel (t019). A second WebSocket to `/api/cdp-ws/{tabId}` that the
  // server tunnels through to the raw CDP target without JSON parsing/stringify. Lets
  // screencast frames flow at the network's native rate (~30+ fps) instead of being
  // capped at ~5-10 fps by the main server's per-frame broadcast loop. Fires
  // Page.screencastFrame events into the same listeners.event the main WS uses so the
  // renderer is unaware. Frames coming from the main server WS are filtered out while
  // this tunnel is active (avoids double-render).
  let frameTunnel: WebSocket | null = null
  let frameTunnelTabId: string | null = null
  let frameTunnelActive = false
  let frameAckId = 1
  function openFrameTunnel(tabId: string) {
    if (frameTunnelTabId === tabId && frameTunnel && frameTunnel.readyState === WebSocket.OPEN)
      return
    closeFrameTunnel()
    frameTunnelTabId = tabId
    const proto = location.protocol === "https:" ? "wss:" : "ws:"
    const sock = new WebSocket(`${proto}//${location.host}/api/cdp-ws/${tabId}`)
    sock.binaryType = "arraybuffer"
    frameTunnel = sock
    sock.onopen = () => {
      // Start screencast at the canvas-sized resolution; viewport.tsx also reissues on
      // resize via the main transport, but this one is the actual frame producer.
      const dpr = window.devicePixelRatio || 1
      const w = Math.floor((document.documentElement.clientWidth || 1280) * dpr)
      const h = Math.floor((document.documentElement.clientHeight || 720) * dpr)
      try {
        sock.send(
          JSON.stringify({
            id: frameAckId++,
            method: "Page.startScreencast",
            params: { format: "jpeg", quality: 80, maxWidth: w, maxHeight: h },
          }),
        )
      } catch {}
      frameTunnelActive = true
    }
    sock.onmessage = (ev) => {
      // Raw CDP JSON-RPC. Parse to spot Page.screencastFrame; everything else (command
      // replies, other events) is ignored — this tunnel is screencast-only.
      const text = typeof ev.data === "string" ? ev.data : ""
      if (!text || !text.includes('"Page.screencastFrame"')) return
      let msg: { method?: string; params?: { sessionId?: number } }
      try {
        msg = JSON.parse(text)
      } catch {
        return
      }
      if (msg.method !== "Page.screencastFrame") return
      // Ack immediately on the tunnel so CDP keeps emitting.
      if (msg.params?.sessionId !== undefined) {
        try {
          sock.send(
            JSON.stringify({
              id: frameAckId++,
              method: "Page.screencastFrameAck",
              params: { sessionId: msg.params.sessionId },
            }),
          )
        } catch {}
      }
      // Dispatch into the same listeners path the main transport uses.
      for (const cb of listeners.event) cb(msg)
    }
    sock.onclose = () => {
      frameTunnelActive = false
      if (frameTunnel === sock) frameTunnel = null
    }
    sock.onerror = () => {
      try {
        sock.close()
      } catch {}
    }
  }
  function closeFrameTunnel() {
    frameTunnelActive = false
    frameTunnelTabId = null
    if (frameTunnel) {
      try {
        frameTunnel.close()
      } catch {}
      frameTunnel = null
    }
  }
  // Inspect a CDP envelope from the main WS path; return true if it's a screencast frame
  // we should drop because the tunnel is delivering frames already.
  function isFilteredCdpEvent(msg: unknown): boolean {
    if (!frameTunnelActive) return false
    return (
      typeof msg === "object" &&
      msg !== null &&
      (msg as { method?: string }).method === "Page.screencastFrame"
    )
  }

  // Mode reconfiguration: called by the picker on change. Re-reads the pref, opens or
  // closes WS to match, and pokes the active-mode signal. The streaming channel stays
  // alive across switches — cheap, and lets a flip back to auto/stream resume instantly.
  function reconfigureMode() {
    wantMode = readMode()
    if (wantMode === "auto" || wantMode === "ws") {
      selector.fallbackToAuto() // clears any manual error state from a prior pick
      if (wantMode === "ws") selector.setManualMode("ws")
      if (!ws) openWs()
    } else {
      // stream or batch: tear down WS so input flows through the legacy paths.
      selector.setManualMode(wantMode)
      closeWs()
    }
    setActiveMode(deriveActiveMode())
  }

  // Re-probe on visibility return: a network change (VPN flip, WiFi roam) is most likely
  // when the user comes back. If we'd been degraded (Auto fell below WS), try WS again.
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return
      const probe = selector.onFocus()
      if (probe === "ws" && !wsReady && !ws && shouldOpenWs(wantMode)) openWs()
    })
  }

  // Theme: the "native" scheme is the OS preference via matchMedia, overridden by an
  // explicit theme source. We push the *resolved* dark flag to the server so it can
  // emulate prefers-color-scheme on the remote page, and notify the renderer.
  let themeSource: "system" | "light" | "dark" = "system"
  const mql =
    typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : null
  const resolveDark = () => (themeSource === "system" ? !!mql?.matches : themeSource === "dark")
  function pushTheme() {
    const isDark = resolveDark()
    void postJson("/api/theme", { isDark })
    for (const cb of listeners.nativeTheme) cb(isDark)
  }
  mql?.addEventListener("change", pushTheme)

  return {
    listTabs: () => getJson("/api/tabs"),
    newTab: (url) => postJson("/api/tabs/new", { url }),
    closeTab: (id) => postJson("/api/tabs/close", { id }),
    connect: async (id) => {
      const result = await postJson("/api/connect", { id })
      // Direct-frame tunnel (t019, fastest): open a pass-through WS to the active tab's
      // CDP socket and pull screencast frames at native rate, bypassing the server's
      // per-frame JSON.parse/stringify cost. Default ON; disable via
      // `localStorage.directFrames='0'`. Skipped when no WebSocket support, or when the
      // main WS isn't ready (we follow the same gating as input WS for consistency).
      // Default OFF: the binary WS broadcast path is faster than the tunnel because
      // opening a 2nd CDP session competes with the server's main one for frame
      // production, AND the tunnel forwards raw CDP JSON (no binary Blob, so the
      // renderer falls back to data-URL decode — slow on WebKit). Enable explicitly
      // with `localStorage.directFrames='1'` if testing.
      const wantDirect = !!(window.WebSocket && localStorage?.getItem("directFrames") === "1")
      if (wantDirect) openFrameTunnel(id)
      else closeFrameTunnel()
      return result
    },
    send: (method, params) => {
      if (method === "Page.screencastFrameAck") return // server acks frames itself
      const cmd: Cmd = { method, params }
      if (method === "Input.dispatchMouseEvent") {
        const p = params as { type?: string; buttons?: number } | undefined
        if (p?.type === "mouseMoved") {
          // Drag (a button is held): always track live.
          // Hover (no button): held by the 80ms gate only on the POST/cdp-batch fallback,
          // where each batch costs a TLS+auth RTT and a continuous hover starves clicks.
          // WS and streaming have no per-message setup cost — let hover flow live.
          const liveMove = !!p.buttons || wsReady || streamingActive
          if (liveMove) {
            hover.cancel()
            return batcher.coalesce(cmd)
          }
          return hover.move(cmd)
        }
        if (p?.type === "mouseWheel") return batcher.append(cmd)
        // Press / release: send now, and drop any held hover (this position supersedes it).
        hover.cancel()
        return batcher.immediate(cmd)
      }
      if (method === "Input.dispatchKeyEvent") return batcher.immediate(cmd)
      if (wsReady && ws) {
        void ws.send(method, params)
        return
      }
      void postJson("/api/send", cmd)
    },
    invoke: (method, params) => {
      if (wsReady && ws) return ws.invoke(method, params) as Promise<unknown>
      return postJson("/api/invoke", { method, params })
    },
    onEvent: (cb) => listeners.event.push(cb),
    onDisconnected: (cb) => listeners.disconnected.push(cb),
    getConfig: () => getJson("/api/config"),
    setConfig: (config) => postJson("/api/config", config),
    testConfig: (config) => postJson("/api/config/test", config),
    getSidebarWidth: () => getJson("/api/sidebar-width"),
    setSidebarWidth: (width) => postJson("/api/sidebar-width", { width }),
    getUiState: async () => {
      const ui = await getJson("/api/ui-state")
      webPush = !!ui.webPush
      return ui
    },
    setUiState: (partial) => {
      if ("webPush" in partial) webPush = !!partial.webPush
      return postJson("/api/ui-state", partial)
    },
    setThemeSource: async (source) => {
      themeSource = source
      await postJson("/api/theme-source", { source })
      pushTheme()
    },
    getThemeSource: async () => {
      themeSource = await getJson("/api/theme-source")
      pushTheme()
      return themeSource
    },
    onNativeThemeChanged: (cb) => listeners.nativeTheme.push(cb),
    copyToClipboard: async (text) => {
      try {
        await navigator.clipboard?.writeText(text)
      } catch (e) {
        console.error("[web] clipboard write failed:", e)
      }
    },
    onSwipe: () => {}, // no trackpad swipe over the web
    getPins: () => getJson("/api/pins"),
    addPin: (pin) => postJson("/api/pins/add", pin),
    updatePin: (id, patch) => postJson("/api/pins/update", { id, patch }),
    removePin: (id) => postJson("/api/pins/remove", { id }),
    reorderPins: (pins) => postJson("/api/pins/reorder", { pins }),
    getNotifications: () => getJson("/api/notifications"),
    markNotificationRead: (id) => postJson("/api/notifications/mark-read", { id }),
    markNotificationUnread: (id) => postJson("/api/notifications/mark-unread", { id }),
    markNotificationsRead: () => postJson("/api/notifications/mark-all-read"),
    clearNotifications: () => postJson("/api/notifications/clear"),
    onNotification: (cb) => listeners.notification.push(cb),
    onNotificationActivate: (cb) => listeners.notificationActivate.push(cb),
    getPushVapidKey: async () => {
      const r = await getJson("/api/notifications/vapid-public-key")
      return r.key as string
    },
    subscribePush: (sub) => postJson("/api/notifications/subscribe", sub),
    unsubscribePush: (endpoint) => postJson("/api/notifications/unsubscribe", { endpoint }),
    // Transport-picker hooks (t019). The settings UI calls reconfigureInputTransport()
    // when the user toggles a mode; the badge reads getActiveTransport() and subscribes
    // via onActiveTransportChange(). Optional on the bridge — Electron's preload doesn't
    // implement them, so the UI must guard with `?.`.
    reconfigureInputTransport: () => reconfigureMode(),
    getActiveTransport: () => activeMode,
    onActiveTransportChange: (cb: (m: InputTransportMode) => void) => {
      activeModeListeners.push(cb)
    },
  }
}

// Local tabs / extensions don't exist on the web; a no-op bridge keeps the callers
// that reference window.local from crashing while the UI hides their affordances.
function createNoopLocal(): LocalBridge {
  const emptyExt = () => Promise.resolve({ extensions: [] as LocalExtensionInfo[] })
  return {
    getPins: () => Promise.resolve([]),
    savePins: () => Promise.resolve(),
    getExtensions: () => Promise.resolve([]),
    pickExtension: emptyExt,
    reloadExtension: emptyExt,
    removeExtension: emptyExt,
    openActionPopup: () => Promise.resolve(),
    closeActionPopup: () => Promise.resolve(),
  }
}

// Pre-React DOM overlay that blocks until a passphrase is entered (React isn't mounted
// yet — the key must exist before any /api call). Resolves the entered string.
function promptPassphrase(showError: boolean): Promise<string> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div")
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:#0a0a0a;color:#e5e5e5;font-family:system-ui,sans-serif"
    overlay.innerHTML = `<form style="display:flex;flex-direction:column;gap:12px;width:320px;padding:24px;border:1px solid #2a2a2a;border-radius:12px;background:#141414">
      <div style="font-size:14px;font-weight:600">Encrypted session</div>
      <div style="font-size:12px;color:#888;line-height:1.4">Enter the passphrase to decrypt this session.${showError ? ' <span style="color:#f87171">Wrong passphrase.</span>' : ""}</div>
      <input type="password" autocomplete="off" style="padding:8px 10px;border:1px solid #2a2a2a;border-radius:8px;background:#0a0a0a;color:#e5e5e5;font-size:13px" />
      <button type="submit" style="padding:8px;border:0;border-radius:8px;background:#3b82f6;color:#fff;font-size:13px;cursor:pointer">Unlock</button>
    </form>`
    const form = overlay.querySelector("form") as HTMLFormElement
    const input = overlay.querySelector("input") as HTMLInputElement
    form.addEventListener("submit", (ev) => {
      ev.preventDefault()
      if (!input.value) return
      overlay.remove()
      resolve(input.value)
    })
    document.body.appendChild(overlay)
    input.focus()
  })
}

// If the server has E2E on, establish the key before anything connects: derive from the
// passphrase (stored or prompted) + served salt, and confirm by decrypting the verifier.
async function bootstrapE2E(): Promise<void> {
  const params = await fetch("/api/crypto-params")
    .then((r) => r.json())
    .catch(() => ({ e2e: false }))
  if (!params.e2e) return
  let stored = sessionStorage.getItem(E2E_PASS_STORE) || ""
  let error = false
  for (;;) {
    const pass = stored || (await promptPassphrase(error))
    stored = ""
    const key = await envDeriveKey(pass, params.salt, params.iterations)
    try {
      await envOpen(params.verifier, key) // GCM auth fails ⇒ wrong passphrase
      e2eKey = key
      sessionStorage.setItem(E2E_PASS_STORE, pass)
      return
    } catch {
      sessionStorage.removeItem(E2E_PASS_STORE)
      error = true
    }
  }
}

/** Install the web runtime if we're not running under Electron's preload. */
export async function installWebRuntimeIfNeeded() {
  if (typeof window === "undefined" || window.cdp) return
  await bootstrapE2E()
  window.webCaps = DEFAULT_CAPS
  window.cdp = createWebCdp()
  window.local = createNoopLocal()
}
