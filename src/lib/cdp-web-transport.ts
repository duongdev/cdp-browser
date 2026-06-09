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

import { DEFAULT_CAPS, getCaps, type WebCaps } from "./caps"
import { type CryptoContext, createCryptoContext } from "./crypto-context"
import { deriveKey as envDeriveKey, open as envOpen } from "./crypto-envelope"
import {
  createDownlink,
  createDownlinkDispatcher,
  type DownlinkSource,
  type DownlinkSourceHandlers,
} from "./downlink-dispatcher"
import { type Batch, createBatcher, createHoverGate, createSingleFlight } from "./input-coalesce"
import { noteFrameAge, notePing, notePong, resetLatencyMetrics } from "./latency-metrics"
import { perfMark } from "./perf-mark"
import {
  type BackoffConfig,
  type BackoffState,
  initialBackoff,
  nextBackoff,
} from "./reconnect-backoff"
import {
  createTransportSelector,
  createWsReclimbSchedule,
  type InputTransportMode,
  shouldReconnect,
} from "./transport-selector"
import { type AdvisedMode, createUplinkRouter, type Uplink } from "./uplink-router"

// Capabilities moved to ./caps (the pure source of truth). Re-exported so existing
// importers of this module keep working — see docs/conventions/feature-gates.md.
export { getCaps, type WebCaps }

type Cmd = { method: string; params?: unknown }

/**
 * Injectable dependency bag (test seam, t020). Production calls `createWebCdp()` with no
 * argument, so `resolveDeps()` reaches for the real browser globals — the exact behavior
 * before this seam existed. Tests pass fakes for `fetch`/`EventSource`/`WebSocket` (and
 * optionally `matchMedia`/`localStorage`/`getE2eKey`) to drive the shim with no network.
 * No production branch is added or removed by this bag.
 */
export interface WebTransportDeps {
  fetch: typeof fetch
  EventSource: typeof EventSource
  WebSocket: typeof WebSocket
  matchMedia?: (q: string) => MediaQueryList
  localStorage?: Pick<Storage, "getItem" | "setItem">
  /** The live E2E key (or null when off). A getter so production tracks the module var
   *  that `bootstrapE2E` sets; tests supply a fixed key. */
  getE2eKey?: () => CryptoKey | null
  /** Backoff timer seam for the reconnect driver (t040). Defaults to the real
   *  `setTimeout`/`clearTimeout`; tests inject fakes so the loop runs without waiting. */
  setTimer?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (h: ReturnType<typeof setTimeout>) => void
}

function resolveDeps(): WebTransportDeps {
  return {
    fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
    EventSource: globalThis.EventSource,
    WebSocket: globalThis.WebSocket,
    matchMedia: typeof window !== "undefined" ? (q) => window.matchMedia(q) : undefined,
    localStorage: typeof localStorage !== "undefined" ? localStorage : undefined,
    getE2eKey: () => e2eKey,
    setTimer: (cb, ms) => setTimeout(cb, ms),
    clearTimer: (h) => clearTimeout(h),
  }
}

// Bounded-backoff defaults for auto-reconnect on a real drop (t040). 0.5s → 1s → 2s →
// 4s → 8s → 16s (capped at 16s), giving up after 10 tries (~2 min of retries) — long
// enough to ride out a host restart / network blip, bounded so a dead host settles on a
// terminal "Disconnected" instead of retrying forever.
const RECONNECT_CONFIG: BackoffConfig = {
  baseMs: 500,
  factor: 2,
  capMs: 16000,
  maxAttempts: 10,
}

/**
 * The effectful reconnect loop (t040) — the pure schedule's caller. On a real Remote Page
 * drop it re-invokes `connect(lastTabId)` on the bounded-backoff cadence, surfacing a
 * "reconnecting" phase while it retries and a terminal "lost" once the ceiling is hit. A
 * fresh `connect` (a tab switch, or a retry that lands) resets the schedule and cancels any
 * queued retry; `stop()` (host-initiated teardown) does the same. The server-side
 * `connectId` race-guard discards a retry that resolves after a newer connect, so this loop
 * never promotes a stale socket — it just drives `connect` through the same guard.
 */
export function createReconnectDriver(opts: {
  connect: (tabId: string) => Promise<{ ok?: boolean; error?: string }>
  emit: (phase: "reconnecting" | "lost") => void
  config?: BackoffConfig
  setTimer?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (h: ReturnType<typeof setTimeout>) => void
}) {
  const cfg = opts.config ?? RECONNECT_CONFIG
  const setTimer = opts.setTimer ?? ((cb, ms) => setTimeout(cb, ms))
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h))

  let state: BackoffState = initialBackoff()
  let lastTabId: string | null = null
  let pending: ReturnType<typeof setTimeout> | null = null
  // Bumped on every connect()/stop(); a retry whose timer fires for a stale generation is
  // dropped (the renderer-side mirror of the connector's connectId guard).
  let generation = 0

  function cancelPending() {
    if (pending !== null) {
      clearTimer(pending)
      pending = null
    }
  }

  function scheduleNext() {
    const { state: next, step } = nextBackoff(state, "drop", cfg)
    state = next
    if (step.giveUp) {
      opts.emit("lost")
      return
    }
    opts.emit("reconnecting")
    const myGen = generation
    pending = setTimer(async () => {
      pending = null
      if (myGen !== generation || lastTabId === null) return
      const result = await opts.connect(lastTabId)
      if (myGen !== generation) return // a newer connect/stop superseded this retry
      if (result?.ok) {
        state = nextBackoff(state, "success", cfg).state
        return
      }
      // "cancelled" means a newer connect took the slot — stop quietly (gen already bumped
      // in that case). Any other error is the host still being down → climb the next rung.
      if (result?.error !== "cancelled") scheduleNext()
    }, step.delayMs)
  }

  return {
    /** A fresh, intentional connect (tab switch or initial). Records the target, resets the
     *  schedule, and cancels any queued retry so the loop never races a deliberate connect. */
    noteConnect(tabId: string) {
      lastTabId = tabId
      generation++
      cancelPending()
      state = nextBackoff(state, "success", cfg).state
    },
    /** A real drop surfaced by the Downlink. Kicks the backoff loop. */
    onDrop() {
      if (lastTabId === null) {
        // Never connected (or host-disconnected) — surface the terminal loss, don't retry.
        opts.emit("lost")
        return
      }
      cancelPending()
      scheduleNext()
    },
    /** A manual force-reconnect (status-bar / settings tap, later the ⌘K command). Cancels
     *  any pending backoff timer, resets the schedule to its base delay, and re-enters the
     *  *same* `connect` path the auto-loop uses — immediately, for the last tab — never a
     *  second competing loop. Bumping `generation` first supersedes any queued auto-retry
     *  (the renderer mirror of the server `connectId` guard), so rapid taps don't stack: a
     *  later tap discards the earlier attempt instead of opening a second socket. */
    reconnectNow() {
      if (lastTabId === null) return // nothing to reconnect to (never connected / host gone)
      generation++
      cancelPending()
      state = initialBackoff()
      const tabId = lastTabId
      const myGen = generation
      opts.emit("reconnecting")
      void opts.connect(tabId).then((result) => {
        if (myGen !== generation) return // a newer connect/tap/stop superseded this attempt
        if (result?.ok) {
          state = nextBackoff(state, "success", cfg).state
          return
        }
        // Host still down → fall into the normal bounded-backoff climb (one loop, shared cfg).
        if (result?.error !== "cancelled") scheduleNext()
      })
    },
    /** Host-initiated teardown — stop retrying and forget the target. */
    stop() {
      generation++
      cancelPending()
      lastTabId = null
      state = initialBackoff()
    },
  }
}

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

let e2eKey: CryptoKey | null = null
const E2E_PASS_STORE = "cdp-e2e-pass"

/**
 * The REST bridge: tabs/config/ui-state/pins/notifications/theme reads and writes. The only
 * E2E seal/open these do is the CryptoContext's `sealText`/`openText` — no inline key read,
 * no `envSeal`/`envOpen` call. `getJson`/`postJson` decode their response through the context;
 * `postRaw` posts an already context-serialized line verbatim (the input adapters seal their
 * batch, then post it here). In off mode the body is built synchronously (plaintext JSON, no
 * envelope) so the fetch fires on the same tick as before — the seal `await` is e2e-only.
 */
function createRestBridge(deps: WebTransportDeps, crypto: CryptoContext) {
  // Fire the POST. Off mode serializes plaintext synchronously and reaches `fetch` on the
  // same tick (no `await` before it) — preserving the pre-fold timing; e2e awaits the one
  // seal site (`crypto.sealText`) first. Returns the Response promise either way.
  const postBody = (path: string, body?: unknown): Promise<Response> => {
    const headers = { "Content-Type": crypto.contentType }
    if (crypto.mode === "off") {
      return deps.fetch(path, { method: "POST", headers, body: JSON.stringify(body ?? {}) })
    }
    return crypto
      .sealText(body ?? {})
      .then((sealed) => deps.fetch(path, { method: "POST", headers, body: sealed }))
  }
  return {
    // biome-ignore lint/suspicious/noExplicitAny: bridge bodies are dynamic JSON matching the Promise<any> CdpBridge contract these feed
    async getJson(path: string): Promise<any> {
      const res = await deps.fetch(path)
      return crypto.openText(await res.text())
    },
    // biome-ignore lint/suspicious/noExplicitAny: see getJson.
    async postJson(path: string, body?: unknown): Promise<any> {
      const res = await postBody(path, body)
      if (res.status === 204) return undefined
      return crypto.openText(await res.text())
    },
    async postRaw(path: string, line: string) {
      await deps.fetch(path, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: line,
      })
    },
  }
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
function createInputChannel(deps: WebTransportDeps, postFallback: (batch: Batch<Cmd>) => void) {
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
    deps
      .fetch("/api/input-stream", {
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
function createWsChannel(
  deps: WebTransportDeps,
  crypto: CryptoContext,
  opts: {
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
  },
) {
  let socket: WebSocket | null = null
  let ready = false
  // Pending awaited invokes keyed by id; the server echoes the id in invoke-result.
  let nextId = 1
  const pending = new Map<number, (result: unknown) => void>()
  // True when the outer asked us to close — suppresses the onClose callback so a stale
  // socket's late `close` event doesn't clobber a newly-opened channel's outer state.
  let suppressClose = false

  // Keepalive + RTT probe (t057). While the socket is ready, a plaintext `ping` carrying a
  // client-monotonic stamp fires on a fixed interval regardless of input/frame traffic, so
  // an idle WS isn't reaped by an upstream proxy (nginx default idle ~60s). The server pongs
  // it straight back; the onmessage handler folds the round-trip into the RTT estimator. The
  // ping is control traffic — never sealed, never routed through the dispatcher's CDP path.
  const PING_INTERVAL_MS = 20000
  let pingSeq = 0
  let pingTimer: ReturnType<typeof setInterval> | null = null
  function sendPing() {
    if (!socket || socket.readyState !== deps.WebSocket.OPEN) return
    const seq = ++pingSeq
    const sentAt = performance.now()
    notePing(seq, sentAt)
    try {
      // `ts` carries the client's monotonic stamp; the server echoes it unchanged. RTT is
      // measured against the local `outstanding` map keyed by `seq`, never the echoed `ts`.
      socket.send(JSON.stringify({ t: "ping", seq, ts: sentAt }))
    } catch {}
  }
  function startPingPump() {
    if (pingTimer !== null) return
    sendPing() // probe immediately so RTT lands without waiting a full interval
    pingTimer = setInterval(sendPing, PING_INTERVAL_MS)
  }

  // Ack-after-paint control (t056) — plaintext like ping (no user content), so it's E2E-
  // agnostic and skips the seal round-trip. `frame-ack-mode` opts this client into the
  // server's one-in-flight gate; `frame-ack` is the post-paint ack the viewport fires,
  // releasing the slot so the server acks the remote and the next frame flows.
  function sendControl(payload: unknown) {
    if (!socket || socket.readyState !== deps.WebSocket.OPEN) return
    try {
      socket.send(JSON.stringify(payload))
    } catch {}
  }
  function stopPingPump() {
    if (pingTimer !== null) {
      clearInterval(pingTimer)
      pingTimer = null
    }
    // The estimator degrades cleanly when WS is gone — report unavailable, not a stale RTT.
    resetLatencyMetrics()
  }

  function open() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:"
    const url = `${proto}//${location.host}/api/ws`
    try {
      socket = new deps.WebSocket(url)
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
      let msg: {
        t: string
        event?: string
        data?: unknown
        id?: number
        result?: unknown
        seq?: number
      }
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
        startPingPump()
        sendControl({ t: "frame-ack-mode" }) // opt into the server's one-in-flight gate (t056)
        opts.onReady()
      } else if (msg.t === "pong") {
        // Control traffic — never fanned out as a CDP event. Fold the round-trip into the
        // always-on RTT/jitter estimator against the client clock (t057).
        if (typeof msg.seq === "number") notePong(msg.seq, performance.now())
      } else if (msg.t === "event" && msg.event === "cdp-frame") {
        // Stash metadata; the next binary message is the JPEG bytes for this frame.
        pendingFrame = msg.data as { method: string; params: Record<string, unknown> }
      } else if (msg.t === "event" && msg.event && msg.data !== undefined) {
        opts.onEvent(msg.event, msg.data as string)
      } else if (msg.t === "invoke-result" && typeof msg.id === "number") {
        const cb = pending.get(msg.id)
        pending.delete(msg.id)
        // Result is sealed under E2E (the routing envelope around it stays plaintext); the
        // open is the CryptoContext's, the one downlink ingress for an invoke reply.
        const result =
          crypto.mode === "e2e" ? await crypto.openText(msg.result as string) : msg.result
        cb?.(result)
      }
    }
    socket.onclose = () => {
      ready = false
      socket = null
      stopPingPump()
      for (const cb of pending.values()) cb({ error: "ws closed" })
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
    if (!socket || socket.readyState !== deps.WebSocket.OPEN) return false
    // One seal at the WS uplink egress — the whole `{ t, … }` envelope is sealed (the server
    // opens it as one body), via the CryptoContext, not an inline key read.
    const text = await crypto.sealText(payload)
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
    paintAck: (sessionId: number) => sendControl({ t: "frame-ack", sessionId }),
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

export function createWebCdp(deps: WebTransportDeps = resolveDeps()): CdpBridge {
  // E2E lives at the seam boundary, not per call (t023). The CryptoContext is the single
  // owner of the envelope: it is the only thing that calls `envSeal`/`envOpen`. Built once at
  // assembly from the live key (set by `bootstrapE2E` before this runs, so the handshake is
  // already confirmed). The uplink seam seals every client→server body through `crypto.sealText`
  // before it leaves (the adapter that forms the wire object calls it — seal precedes the
  // transport pick, never per-transport-after-routing); the downlink pump (`pumpSse`) opens
  // every server→client payload through `crypto.openText` once before the dispatcher fans it
  // out. The REST bridge serializes its bodies through the same context. No other site reads
  // the key. The egress/ingress handshake gates consult `crypto.ready`.
  const currentE2eKey = deps.getE2eKey?.() ?? null
  const crypto: CryptoContext = currentE2eKey
    ? createCryptoContext({ mode: "e2e", key: currentE2eKey })
    : createCryptoContext({ mode: "off" })
  const rest = createRestBridge(deps, crypto)

  // The single dispatcher behind the Downlink seam (t021). Every decoded server push —
  // from the WS source, the WS binary-frame source, or the SSE source — fans out here, and
  // a Notification fires the toast exactly once. The four inline fan-out paths that used to
  // re-implement this collapsed into the one dispatcher. `nativeTheme` is a local-only
  // signal (no source push), so it stays a plain listener list.
  const dispatcher = createDownlinkDispatcher<CdpNotification>({
    toast: (e) => maybeToast(e),
    // Always-on frame age (t057): the dispatcher hands every screencast frame's server send
    // timestamp here before fan-out; the recorder corrects for the RTT/2 one-way offset.
    recordFrameAge: (serverTs) => noteFrameAge(performance.now(), serverTs),
  })
  const nativeThemeListeners: ((isDark: boolean) => void)[] = []

  // Auto-reconnect on a real drop (t040). The dispatcher's raw `disconnected` (the
  // real-drop signal that survives t039) feeds the driver, which re-invokes the REST
  // `connect` on a bounded-backoff cadence and surfaces a phase to the renderer:
  // "reconnecting" while it retries, "lost" once the ceiling is hit. The renderer's
  // `onDisconnected` listeners read the *driver's* phased output, not the raw dispatch, so
  // a normal reconnect shows progress (not a terminal error) and only clears when frames
  // resume. The retry's `connect` flows through the server-side `connectId` race-guard, so
  // a retry overlapping a tab switch is discarded server-side — no stale socket promoted.
  const disconnectedListeners: ((phase?: "reconnecting" | "lost") => void)[] = []
  const reconnect = createReconnectDriver({
    connect: (tabId) => rest.postJson("/api/connect", { id: tabId }),
    emit: (phase) => {
      for (const cb of disconnectedListeners) cb(phase)
    },
    setTimer: deps.setTimer,
    clearTimer: deps.clearTimer,
  })
  dispatcher.onDisconnected(() => reconnect.onDrop())

  // The Downlink seam: exactly one live source (WS-backed or SSE-backed, never both) feeds
  // the dispatcher. The physical channel swaps mid-session (WS ready tears down SSE; WS drop
  // reopens SSE), but there is always one logical Downlink whose `onEvent` is the only gate
  // into the dispatcher. The decoded pumps below (`pumpSse`, the WS callbacks) push through
  // `pumpDownlink` so the seam — not a scattered `dispatcher.dispatch` — owns the
  // single-source guarantee. `downlink.close()` detaches the source (the seam is reusable by
  // the uplink router in 022); the session-long shim never closes it on its own.
  let pumpDownlink: DownlinkSourceHandlers["onEvent"] = () => {}
  const downlinkSource: DownlinkSource = {
    attach(handlers) {
      pumpDownlink = handlers.onEvent
    },
    detach() {
      pumpDownlink = () => {}
    },
  }
  // Construct the Downlink for its `attach` side effect (it wires `pumpDownlink` to the
  // dispatcher, like `attachSseListeners(es)` below wires the SSE source). The session-long
  // shim never tears it down; the seam's `close()`/`onClose` are the contract the uplink
  // router (022) and the unit tests drive.
  createDownlink(dispatcher, downlinkSource)

  // Mode selection (t019). User pref from localStorage controls what's attempted; the
  // actual active mode is derived from runtime state (wsReady? streamReady? else batch).
  // The picker writes the pref and triggers reconfigureMode() to apply mid-session.
  const VALID_MODES: InputTransportMode[] = ["auto", "ws", "stream", "batch"]
  function readMode(): InputTransportMode {
    if (!deps.localStorage) return "auto"
    const raw = deps.localStorage.getItem("inputTransport")
    // Validate against the union — a stale or hand-edited value falls back to auto rather
    // than silently shaping subsequent branches (e.g. wsAllowed) with garbage.
    return raw && (VALID_MODES as string[]).includes(raw) ? (raw as InputTransportMode) : "auto"
  }
  let wantMode: InputTransportMode = readMode()
  const selector = createTransportSelector({
    cache: deps.localStorage ?? { getItem: () => null, setItem: () => {} },
  })
  let wsReady = false
  let ws: ReturnType<typeof createWsChannel> | null = null
  // Visible-tab WS re-climb cadence (t041): reuses the t040 backoff schedule so re-attempts
  // are spaced on the same curve (no second competing counter), resetting when WS heals.
  const reclimbSchedule = createWsReclimbSchedule(RECONNECT_CONFIG)
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
  let es: EventSource = new deps.EventSource("/api/events")
  function teardownSse() {
    try {
      es.close()
    } catch {}
  }
  function reopenSse() {
    es = new deps.EventSource("/api/events")
    attachSseListeners(es)
  }
  // The single downlink ingress: open a server push (plaintext JSON, or a sealed envelope
  // under E2E) through the CryptoContext, then route it to the dispatcher. This is the one
  // place the open happens on the server→client path — the dispatcher (its sole consumer)
  // never sees a sealed payload. Decode is async, so serialize through one chain to hold
  // frame/event order; the dispatcher owns fan-out + toast-once. The handshake gate refuses
  // to dispatch until `crypto.ready` (today always confirmed at build).
  let sseChain: Promise<unknown> = Promise.resolve()
  function pumpSse(kind: string, data: string) {
    if (!crypto.ready) return
    if (crypto.mode === "off") {
      pumpDownlink(kind, JSON.parse(data))
      return
    }
    sseChain = sseChain.then(async () => pumpDownlink(kind, await crypto.openText(data)))
  }
  function attachSseListeners(src: EventSource) {
    src.addEventListener("cdp", (e) => {
      if (wsReady) return // WS carries CDP events; SSE is fallback only (we also close it).
      pumpSse("cdp", (e as MessageEvent).data)
    })
    src.addEventListener("disconnected", () => pumpDownlink("disconnected", undefined))
    src.addEventListener("notification", (e) => pumpSse("notification", (e as MessageEvent).data))
    src.addEventListener("notification-activate", (e) =>
      pumpSse("notification-activate", (e as MessageEvent).data),
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
        source: msg.data.source ?? "",
        title: msg.data.title ?? "",
        body: msg.data.body ?? "",
        targetId: msg.data.targetId,
        targetUrl: msg.data.targetUrl,
        targetEntity: msg.data.targetEntity,
        adapter: msg.data.adapter,
        groupKey: msg.data.groupKey,
        activate: msg.data.activate,
        ts: msg.data.ts ?? Date.now(),
        read: false,
      }
      dispatcher.dispatch("notification-activate", entry)
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
      dispatcher.dispatch("notification-activate", entry)
      n.close()
    }
  }

  // WS open is re-callable so the picker can apply mid-session (close, switch mode, retry).
  // If WS opens, frames + events arrive via WS and the batcher uses WS; if it fails or the
  // user picked a slower mode, the existing SSE+POST/stream paths handle everything.
  function openWs() {
    if (!deps.WebSocket) return
    if (ws) return // already attempting / open
    ws = createWsChannel(deps, crypto, {
      onFrameBinary: (cdpMsg) => {
        // The WS binary-frame path: a forged Page.screencastFrame carrying the JPEG Blob.
        // Routes through the one Downlink like every other CDP event — the viewport reads
        // `dataBlob` first (fast createImageBitmap decode), else the legacy `data` base64.
        // Screencast Frame thus has a single delivery source (the dispatcher), WS-binary
        // and SSE alike — no per-path copy, no frame-tunnel dedup branch.
        pumpDownlink("cdp", cdpMsg)
      },
      onEvent: (event, data) => {
        // WS events arrive E2E-sealed (the routing envelope is plaintext); decode through
        // the same chain SSE uses, then dispatch. One source feeds the dispatcher at a time
        // (SSE is torn down on WS ready), so this is the live Downlink while WS is up.
        // `disconnected` carries no meaningful payload — dispatch it without a decode hop.
        if (event === "disconnected") pumpDownlink("disconnected", undefined)
        else pumpSse(event, data as string)
      },
      onReady: () => {
        wsReady = true
        selector.recordRetry("ws", true)
        // Coming back from a degraded state — clear it so onFocus doesn't re-trigger.
        if (selector.isDegraded()) selector.clearDegraded()
        // The WS path healed — restart the visible-tab re-climb cadence so the next blip
        // re-attempts from the base, not pinned at the prior rung (t041).
        reclimbSchedule.reset()
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
        // WS just dropped — if we're foregrounded and still intend WS, schedule a spaced
        // re-climb so the fast path self-heals (t041). Goes quiet while hidden / non-WS pick.
        armReclimb(reclimbSchedule.next())
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

  // The Uplink seam (t022): the client→server command path is three interchangeable
  // adapters (WS / stream / POST) behind one `uplink-router` that owns the routing choice
  // in exactly one place. `send`, `sendBatch`, and `invoke` stop knowing which transport
  // exists — they call the router, which picks the advised-mode adapter (falling
  // WS→stream→batch on not-ready). `transport-selector.ts` stays the pure advisor; the
  // router instantiates/tears down. See docs/tasks/022 + ADR-0007.
  //
  // The WS adapter wraps the one socket (`ws`) that also backs the Downlink — one socket,
  // two seams. The stream + POST adapters differ by E2E in transport availability: with E2E
  // off, the stream channel (NDJSON over /api/input-stream) carries batches and falls to
  // single-flight POSTs; with E2E on there is no stream channel (the probe/async-seal/order
  // interplay isn't worth it). The E2E *seal* lives only in the CryptoContext (`crypto.sealText`,
  // called by the e2e batch chain and by the REST bridge); the off branch serializes plaintext
  // JSON synchronously (no envelope seal). So no adapter reads the key or calls `envSeal` —
  // the only branch left is whether a stream channel exists, which is transport, not crypto.

  // A bare single command (not high-frequency input — e.g. a control call) goes to /api/send
  // off-WS, exactly as before. Batched input goes to the adapter-specific batch path
  // (WS batch / stream NDJSON / single-flight /api/cdp-batch).
  const wsUplink: Uplink = {
    isReady: () => wsReady && !!ws,
    send: (cmd) => {
      if (wsReady && ws) void ws.send(cmd.method, cmd.params)
    },
    sendBatch: (cmds) => {
      if (wsReady && ws) void ws.batch(cmds)
    },
    invoke: (method, params) =>
      wsReady && ws ? (ws.invoke(method, params) as Promise<unknown>) : Promise.resolve(undefined),
    close: () => {},
  }

  let streamUplink: Uplink
  let batchUplink: Uplink

  if (crypto.mode === "e2e") {
    let chain: Promise<unknown> = Promise.resolve()
    let e2eSeq = 0
    // No streaming channel under E2E — the stream adapter is never ready, so the router
    // never picks it (advise() never returns "stream" in E2E, but keep this honest).
    streamUplink = {
      isReady: () => false,
      send: () => {},
      sendBatch: () => {},
      invoke: () => Promise.resolve(undefined),
      close: () => {},
    }
    batchUplink = {
      isReady: () => true, // the floor: seal-and-POST is always available
      send: (cmd) => void rest.postJson("/api/send", cmd),
      // Serialize through one chain so the monotonic seq posts in order (the async seal would
      // otherwise let batches race). The seal is `crypto.sealText` — one egress seal site.
      sendBatch: (cmds) => {
        chain = chain.then(async () =>
          rest.postRaw("/api/cdp-batch", await crypto.sealText({ seq: e2eSeq++, items: cmds })),
        )
      },
      invoke: (method, params) => rest.postJson("/api/invoke", { method, params }),
      close: () => {},
    }
  } else {
    // Fallback (no streaming channel): single-flight POSTs with move-collapsing so a
    // high-RTT proxy chain can't back up — at most one /api/cdp-batch in flight, latest
    // cursor position wins. The streaming path bypasses this (it's already low-latency).
    // This branch is statically E2E-off, so the body is plaintext JSON (no envelope seal —
    // the seal lives only in the e2e branch's `crypto.sealText`, the one E2E seal site).
    const fallback = createSingleFlight<Cmd>({
      merge: collapseMoves,
      post: (items) => rest.postRaw("/api/cdp-batch", JSON.stringify({ items })),
    })
    const inputChannel = createInputChannel(deps, (batch) => fallback.push(batch.items))
    // Hand the inputChannel to the SSE listener registered in attachSseListeners — that's
    // the only place stream-ack is wired, so it survives SSE close+reopen on WS bounce.
    inputChannelRef = inputChannel
    let streamSeq = 0
    streamUplink = {
      isReady: () => streamingActive,
      send: (cmd) => void rest.postJson("/api/send", cmd),
      sendBatch: (cmds) => inputChannel.send({ seq: streamSeq++, items: cmds }),
      invoke: (method, params) => rest.postJson("/api/invoke", { method, params }),
      close: () => {},
    }
    batchUplink = {
      isReady: () => true, // the floor: single-flight POST is always available
      send: (cmd) => void rest.postJson("/api/send", cmd),
      sendBatch: (cmds) => fallback.push(cmds),
      invoke: (method, params) => rest.postJson("/api/invoke", { method, params }),
      close: () => {},
    }
  }

  // The router's advice: which adapter to prefer right now. WS/Auto prefer WS (the router
  // falls through to stream/batch when WS isn't ready); explicit Stream/Basic pin their
  // adapter so a stream-ack can't pull a "batch"-pinned user onto the stream. Re-read on
  // every pick, so reconfigureMode() re-points the router with no extra wiring.
  function adviseMode(): AdvisedMode {
    if (wantMode === "stream") return "stream"
    if (wantMode === "batch") return "batch"
    return "ws" // auto | ws
  }
  const router = createUplinkRouter({
    adapters: { ws: wsUplink, stream: streamUplink, batch: batchUplink },
    advise: adviseMode,
  })

  // The single uplink-egress gate: every client→server command crosses here, refused until
  // the E2E handshake confirms (`crypto.ready`). Today the passphrase handshake runs in
  // `bootstrapE2E` before this shim is built, so `ready` is already true and this is a no-op;
  // it makes the seam honest for a future deferred handshake (the mirror of `pumpSse`'s
  // downlink-ingress gate). The seal precedes the transport pick — it's applied by the
  // adapter that forms the wire object, never per-transport-after-routing.
  const uplink: Uplink = {
    isReady: () => router.isReady(),
    send: (cmd) => {
      if (crypto.ready) router.send(cmd)
    },
    sendBatch: (cmds) => {
      if (crypto.ready) router.sendBatch(cmds)
    },
    invoke: (method, params) =>
      crypto.ready ? router.invoke(method, params) : Promise.resolve(undefined),
    close: () => router.close(),
  }

  // Batch input + acks: coalesce moves, accumulate wheel, flush discrete immediately. The
  // batcher no longer picks a transport — it hands every flushed batch to the router, which
  // owns the WS→stream→batch choice. Input coalescing (hover gate / single-flight /
  // move-collapse) is preserved upstream of the router.
  const batcher = createBatcher<Cmd>({
    schedule: (flush) => requestAnimationFrame(flush),
    send: (batch: Batch<Cmd>) => uplink.sendBatch(batch.items),
  })

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
      // stream or batch: tear down WS so input flows through the legacy paths, and stop the
      // re-climb timer so it never forces WS back against the user's manual non-WS pick (t041).
      selector.setManualMode(wantMode)
      closeWs()
      cancelReclimb()
    }
    setActiveMode(deriveActiveMode())
  }

  // Visible-tab WS re-climb (t041): while the document is foregrounded and WS is the intended
  // transport, a bounded timer re-attempts `openWs()` whenever WS is down so a mid-session blip
  // (idle-socket reap, iPad network change) self-heals within a few seconds instead of waiting
  // for the next action. The pure `shouldReconnect` verdict gates each tick; the cadence reuses
  // the t040 backoff schedule (no second competing loop). The timer never runs while hidden —
  // it is armed on `visibilitychange → visible` and on a WS drop, and disarmed when hidden — so
  // a parked PWA doesn't hammer the proxy. This re-climbs the WS *socket*; t040's driver owns
  // the orthogonal Remote Page `/api/connect` reconnect.
  let reclimbTimer: ReturnType<typeof setTimeout> | null = null
  function cancelReclimb() {
    if (reclimbTimer !== null) {
      deps.clearTimer?.(reclimbTimer)
      reclimbTimer = null
    }
  }
  function reclimbState(): Parameters<typeof shouldReconnect>[0] {
    const visible = typeof document === "undefined" || document.visibilityState === "visible"
    return {
      visible,
      wsUp: wsReady,
      attemptInFlight: !!ws && !wsReady,
      intendsWs: shouldOpenWs(wantMode),
    }
  }
  function reclimbTick() {
    reclimbTimer = null
    if (!shouldReconnect(reclimbState())) return // up, attempting, hidden, or non-WS pick
    // Kick one attempt. Its outcome drives the next step: onReady stops the loop (WS is up),
    // onClose re-arms the next spaced attempt. The tick never self-reschedules, so there is
    // exactly one timer per attempt — no overlapping loops.
    openWs()
  }
  function armReclimb(delayMs = 0) {
    if (!deps.setTimer) return
    // Only arm when a re-climb is actually warranted right now — visible, WS-intended, down,
    // and no attempt already in flight (the `shouldReconnect` predicate). Otherwise idle until
    // the next visibility return / WS drop re-arms us. (The tick re-checks before opening, so
    // this is just to avoid a redundant no-op timer.)
    if (!shouldReconnect(reclimbState())) return
    cancelReclimb()
    reclimbTimer = deps.setTimer(reclimbTick, delayMs)
  }

  // Re-probe on visibility return: a network change (VPN flip, WiFi roam) is most likely
  // when the user comes back. If we'd been degraded (Auto fell below WS), try WS again. The
  // re-climb timer is armed on return-to-visible and torn down when the tab is backgrounded.
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") {
        cancelReclimb() // backgrounded — go quiet, no reconnect storm
        return
      }
      const probe = selector.onFocus()
      if (probe === "ws" && !wsReady && !ws && shouldOpenWs(wantMode)) openWs()
      armReclimb() // foregrounded — heal the WS path if it's down
    })
  }

  // Theme: the "native" scheme is the OS preference via matchMedia, overridden by an
  // explicit theme source. We push the *resolved* dark flag to the server so it can
  // emulate prefers-color-scheme on the remote page, and notify the renderer.
  let themeSource: "system" | "light" | "dark" = "system"
  const mql = deps.matchMedia?.("(prefers-color-scheme: dark)") ?? null
  const resolveDark = () => (themeSource === "system" ? !!mql?.matches : themeSource === "dark")
  function pushTheme() {
    const isDark = resolveDark()
    void rest.postJson("/api/theme", { isDark })
    for (const cb of nativeThemeListeners) cb(isDark)
  }
  mql?.addEventListener("change", pushTheme)

  return {
    listTabs: () => rest.getJson("/api/tabs"),
    newTab: (url) => rest.postJson("/api/tabs/new", { url }),
    closeTab: (id) => rest.postJson("/api/tabs/close", { id }),
    connect: (id) => {
      // An intentional connect (tab switch or initial): reset the backoff schedule and
      // cancel any queued retry so the loop never races a deliberate switch.
      reconnect.noteConnect(id)
      return rest.postJson("/api/connect", { id })
    },
    // Manual force-reconnect (t042): the status-bar / settings Reconnect tap drives the same
    // t040 driver — cancel the pending backoff timer, reset the schedule to base, and re-enter
    // `connect` for the last tab through the existing generation guard. No second loop; rapid
    // taps supersede via the guard. Electron's preload doesn't implement this — UI guards `?.`.
    reconnect: () => reconnect.reconnectNow(),
    send: (method, params) => {
      // remote-page.ts auto-acks every frame the instant it dispatches it (pre-paint) — on
      // web that's too early, so swallow it. The real ack rides `ackPaintedFrame` after the
      // viewport paints, over the WS `frame-ack` control. SSE path: server self-acks. (t056)
      if (method === "Page.screencastFrameAck") return
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
      uplink.send(cmd)
    },
    // Post-paint frame ack (t056): the viewport calls this after it draws a frame, capping
    // the in-flight queue at one. Only meaningful on the WS path — the server gates the next
    // frame on it. On SSE (no WS) it's a no-op; the server self-acks there as before.
    ackPaintedFrame: (sessionId) => {
      if (wsReady && ws) ws.paintAck(sessionId)
    },
    invoke: (method, params) => uplink.invoke(method, params),
    onEvent: (cb) => {
      dispatcher.onEvent(cb)
    },
    onDisconnected: (cb) => {
      // Listeners read the driver's phased output ("reconnecting" / "lost"), not the raw
      // dispatch — the driver owns the drop now (see createReconnectDriver wiring above).
      disconnectedListeners.push(cb)
    },
    getConfig: () => rest.getJson("/api/config"),
    setConfig: (config) => rest.postJson("/api/config", config),
    testConfig: (config) => rest.postJson("/api/config/test", config),
    getSidebarWidth: () => rest.getJson("/api/sidebar-width"),
    setSidebarWidth: (width) => rest.postJson("/api/sidebar-width", { width }),
    getUiState: async () => {
      const ui = await rest.getJson("/api/ui-state")
      webPush = !!ui.webPush
      return ui
    },
    setUiState: (partial) => {
      if ("webPush" in partial) webPush = !!partial.webPush
      return rest.postJson("/api/ui-state", partial)
    },
    setThemeSource: async (source) => {
      themeSource = source
      await rest.postJson("/api/theme-source", { source })
      pushTheme()
    },
    getThemeSource: async () => {
      themeSource = await rest.getJson("/api/theme-source")
      pushTheme()
      return themeSource
    },
    onNativeThemeChanged: (cb) => {
      nativeThemeListeners.push(cb)
    },
    copyToClipboard: async (text) => {
      try {
        await navigator.clipboard?.writeText(text)
      } catch (e) {
        console.error("[web] clipboard write failed:", e)
      }
    },
    readClipboard: async () => {
      try {
        return (await navigator.clipboard?.readText?.()) ?? ""
      } catch (e) {
        console.error("[web] clipboard read failed:", e)
        return ""
      }
    },
    // Web reads the clipboard from the native `paste` event (app.tsx), not here — the
    // async Clipboard API can't reliably read images on Safari/iPad. Stub returns null.
    readClipboardImage: async () => null,
    readClipboardFiles: async () => [],
    onSwipe: () => {}, // no trackpad swipe over the web
    getPins: () => rest.getJson("/api/pins"),
    addPin: (pin) => rest.postJson("/api/pins/add", pin),
    updatePin: (id, patch) => rest.postJson("/api/pins/update", { id, patch }),
    removePin: (id) => rest.postJson("/api/pins/remove", { id }),
    reorderPins: (pins) => rest.postJson("/api/pins/reorder", { pins }),
    getNotifications: () => rest.getJson("/api/notifications"),
    markNotificationRead: (id) => rest.postJson("/api/notifications/mark-read", { id }),
    markNotificationUnread: (id) => rest.postJson("/api/notifications/mark-unread", { id }),
    markNotificationsRead: () => rest.postJson("/api/notifications/mark-all-read"),
    clearNotifications: () => rest.postJson("/api/notifications/clear"),
    onNotification: (cb) => {
      dispatcher.onNotification(cb)
    },
    onNotificationActivate: (cb) => {
      dispatcher.onNotificationActivate(cb)
    },
    getPushVapidKey: async () => {
      const r = await rest.getJson("/api/notifications/vapid-public-key")
      return r.key as string
    },
    subscribePush: (sub) => rest.postJson("/api/notifications/subscribe", sub),
    unsubscribePush: (endpoint) => rest.postJson("/api/notifications/unsubscribe", { endpoint }),
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
