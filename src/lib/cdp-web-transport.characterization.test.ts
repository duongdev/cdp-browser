/**
 * Characterization tests (t020) — pin the web shim's *current* observable behavior before
 * the Downlink/Uplink seam split (021-023). They drive `createWebCdp` through injected
 * fakes for fetch / EventSource / WebSocket (and matchMedia / localStorage / e2eKey), with
 * no real network and no live Remote Browser. Assertions are against the observable
 * contract — which listeners fire, which envelope/POST goes out, what the seal produces —
 * never private state, so a behavior-preserving refactor keeps them green.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  collapseMoves,
  createReconnectDriver,
  createWebCdp,
  type WebTransportDeps,
} from "./cdp-web-transport"
import { deriveKey, open as envOpen, seal as envSeal } from "./crypto-envelope"
import type { BackoffConfig } from "./reconnect-backoff"

// --- fakes ----------------------------------------------------------------------------

type SseHandler = (e: { data: string }) => void

/** Fake EventSource: capture per-event-name listeners, let a test `emit` a server push. */
class FakeEventSource {
  static instances: FakeEventSource[] = []
  handlers: Record<string, SseHandler[]> = {}
  closed = false
  constructor(public url: string) {
    FakeEventSource.instances.push(this)
  }
  addEventListener(type: string, cb: SseHandler) {
    if (!this.handlers[type]) this.handlers[type] = []
    this.handlers[type].push(cb)
  }
  close() {
    this.closed = true
  }
  emit(type: string, data: string) {
    for (const cb of this.handlers[type] ?? []) cb({ data })
  }
}

/** Fake WebSocket: capture outbound `send` strings, expose manual open/message/ready. */
class FakeWebSocket {
  static OPEN = 1
  static CONNECTING = 0
  static instances: FakeWebSocket[] = []
  readyState = FakeWebSocket.CONNECTING
  binaryType = "blob"
  sent: string[] = []
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(public url: string) {
    FakeWebSocket.instances.push(this)
  }
  send(text: string) {
    this.sent.push(text)
  }
  close() {
    this.readyState = 3
    this.onclose?.()
  }
  /** Bring the socket up and announce ready so the shim flips wsReady. */
  ready() {
    this.readyState = FakeWebSocket.OPEN
    this.onmessage?.({ data: JSON.stringify({ t: "ready" }) })
  }
  message(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) })
  }
}

interface FetchCall {
  path: string
  init?: RequestInit
}

/** Fake fetch: capture calls, reply with a queued/default JSON or text response. A 204
 *  reply means the shim's postJson returns undefined without trying to decode a body. */
function makeFakeFetch(opts: { reply?: (path: string) => unknown; status?: number } = {}) {
  const calls: FetchCall[] = []
  const fetchFn = vi.fn(async (input: unknown, init?: RequestInit) => {
    const path = String(input)
    calls.push({ path, init })
    const value = opts.reply ? opts.reply(path) : {}
    const text = typeof value === "string" ? value : JSON.stringify(value)
    return {
      status: opts.status ?? 200,
      json: async () => (typeof value === "string" ? JSON.parse(value) : value),
      text: async () => text,
    } as unknown as Response
  })
  return { fetchFn, calls }
}

// A controllable backoff timer (t040): queue scheduled callbacks; `runNext()` fires the
// head and awaits its async body, mirroring a backoff window elapsing. `cleared` records
// cancellations so a test can assert a queued retry was dropped on noteConnect/stop.
function fakeTimers() {
  let nextHandle = 1
  const queued = new Map<number, () => void>()
  const cleared: number[] = []
  return {
    setTimer: (cb: () => void) => {
      const h = nextHandle++
      queued.set(h, cb)
      return h as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer: (h: ReturnType<typeof setTimeout>) => {
      cleared.push(h as unknown as number)
      queued.delete(h as unknown as number)
    },
    async runNext() {
      const entry = [...queued.entries()][0]
      if (!entry) return
      const [h, cb] = entry
      queued.delete(h)
      cb()
      await Promise.resolve()
      await Promise.resolve()
    },
    pendingCount: () => queued.size,
    cleared,
  }
}

// A controllable fake `document` for the visible-tab WS re-climb (t041): a settable
// `visibilityState` plus a `visibilitychange` listener registry so a test can drive
// background/foreground transitions. Installed on globalThis for the createWebCdp run.
function fakeDocument() {
  const handlers: Record<string, Array<() => void>> = {}
  const doc = {
    visibilityState: "visible" as "visible" | "hidden",
    addEventListener(type: string, cb: () => void) {
      if (!handlers[type]) handlers[type] = []
      handlers[type].push(cb)
    },
  }
  return {
    doc,
    setVisibility(state: "visible" | "hidden") {
      doc.visibilityState = state
      for (const cb of handlers.visibilitychange ?? []) cb()
    },
  }
}

// The streaming input channel fires a one-shot probe POST to /api/input-stream at
// construction (Node supports request streaming) — an observed startup quirk, unrelated to
// any send()/batch routing under test. Filter it out when asserting input POSTs.
const inputPosts = (calls: FetchCall[]) =>
  calls.filter((c) => c.path === "/api/cdp-batch" || c.path === "/api/send")

/** The captured request for `path`; asserts exactly one matched. */
function callTo(calls: FetchCall[], path: string): FetchCall {
  const hits = calls.filter((c) => c.path === path)
  expect(hits).toHaveLength(1)
  return hits[0]
}

function baseDeps(over: Partial<WebTransportDeps> = {}): WebTransportDeps {
  const { fetchFn } = makeFakeFetch()
  return {
    fetch: fetchFn as unknown as typeof fetch,
    EventSource: FakeEventSource as unknown as typeof EventSource,
    WebSocket: FakeWebSocket as unknown as typeof WebSocket,
    localStorage: { getItem: () => null, setItem: () => {} },
    getE2eKey: () => null,
    ...over,
  }
}

// Capture the rAF flush so the batcher can be flushed deterministically (node has no rAF).
let rafQueue: Array<() => void> = []
beforeEach(() => {
  FakeEventSource.instances = []
  FakeWebSocket.instances = []
  rafQueue = []
  globalThis.requestAnimationFrame = ((cb: () => void) => {
    rafQueue.push(cb)
    return rafQueue.length
  }) as typeof requestAnimationFrame
  // createWsChannel reads location to build the ws:// URL; the fake WS ignores it, but the
  // global must exist for the read not to throw under node. (Not a transport dependency —
  // just the page origin, like in a browser.)
  ;(globalThis as { location?: unknown }).location = { protocol: "http:", host: "localhost" }
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})
const flushRaf = () => {
  const q = rafQueue
  rafQueue = []
  for (const cb of q) cb()
}

const mouseMove = (x: number, buttons = 0) => ({ type: "mouseMoved", x, buttons })
const press = () => ({ type: "mousePressed", x: 1, y: 1 })
const wheel = (dy: number) => ({ type: "mouseWheel", dy })

// --- collapseMoves --------------------------------------------------------------------

describe("collapseMoves", () => {
  const m = (x: number) => ({
    method: "Input.dispatchMouseEvent",
    params: { type: "mouseMoved", x },
  })
  const click = () => ({ method: "Input.dispatchMouseEvent", params: { type: "mousePressed" } })
  const wh = (dy: number) => ({
    method: "Input.dispatchMouseEvent",
    params: { type: "mouseWheel", dy },
  })
  const key = () => ({ method: "Input.dispatchKeyEvent", params: { type: "keyDown" } })

  it("returns empty for empty input", () => {
    expect(collapseMoves([])).toEqual([])
  })
  it("leaves a single move untouched", () => {
    expect(collapseMoves([m(5)])).toEqual([m(5)])
  })
  it("collapses a consecutive-move run to the latest", () => {
    expect(collapseMoves([m(1), m(2), m(3)])).toEqual([m(3)])
  })
  it("a click breaks a run (order + breaks preserved)", () => {
    expect(collapseMoves([m(1), m(2), click(), m(3), m(4)])).toEqual([m(2), click(), m(4)])
  })
  it("wheel and key break/never collapse", () => {
    expect(collapseMoves([m(1), wh(10), m(2), key(), m(3)])).toEqual([
      m(1),
      wh(10),
      m(2),
      key(),
      m(3),
    ])
  })
})

// --- reconnect driver (t040) ----------------------------------------------------------

describe("createReconnectDriver", () => {
  const fakeTimer = fakeTimers
  const CFG: BackoffConfig = { baseMs: 500, factor: 2, capMs: 8000, maxAttempts: 3 }

  it("a real drop kicks the loop: emits 'reconnecting' then re-invokes connect", async () => {
    const t = fakeTimer()
    const connect = vi.fn(async () => ({ ok: true }))
    const phases: string[] = []
    const d = createReconnectDriver({
      connect,
      emit: (p) => phases.push(p),
      config: CFG,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    })
    d.noteConnect("tab-1")
    d.onDrop()
    expect(phases).toEqual(["reconnecting"])
    expect(connect).not.toHaveBeenCalled() // waits the backoff window first
    await t.runNext()
    expect(connect).toHaveBeenCalledWith("tab-1")
  })

  it("a failed retry climbs the next rung; a success stops the loop and resets", async () => {
    const t = fakeTimer()
    // First retry fails (host still down), second succeeds.
    const results = [{ error: "Tab not found" }, { ok: true as const }]
    const connect = vi.fn(async () => results.shift() ?? { ok: true })
    const phases: string[] = []
    const d = createReconnectDriver({
      connect,
      emit: (p) => phases.push(p),
      config: CFG,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    })
    d.noteConnect("tab-1")
    d.onDrop()
    await t.runNext() // first retry → fails → schedules another
    expect(connect).toHaveBeenCalledTimes(1)
    expect(t.pendingCount()).toBe(1)
    await t.runNext() // second retry → ok → loop done
    expect(connect).toHaveBeenCalledTimes(2)
    expect(t.pendingCount()).toBe(0)
    expect(phases).toEqual(["reconnecting", "reconnecting"])
  })

  it("gives up with 'lost' after the max-attempts ceiling, no further retries", async () => {
    const t = fakeTimer()
    const connect = vi.fn(async () => ({ error: "down" }))
    const phases: string[] = []
    const d = createReconnectDriver({
      connect,
      emit: (p) => phases.push(p),
      config: CFG, // maxAttempts: 3
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    })
    d.noteConnect("tab-1")
    d.onDrop()
    await t.runNext() // attempt 1
    await t.runNext() // attempt 2
    await t.runNext() // attempt 3 → next drop exceeds budget
    expect(connect).toHaveBeenCalledTimes(3)
    expect(phases).toEqual(["reconnecting", "reconnecting", "reconnecting", "lost"])
    expect(t.pendingCount()).toBe(0)
  })

  it("a success outcome resets the budget so a later drop climbs the full ladder again", async () => {
    const t = fakeTimer()
    const results: Array<{ ok?: true; error?: string }> = [{ ok: true }]
    const connect = vi.fn(async () => results.shift() ?? { error: "down" })
    const phases: string[] = []
    const d = createReconnectDriver({
      connect,
      emit: (p) => phases.push(p),
      config: CFG,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    })
    d.noteConnect("tab-1")
    d.onDrop()
    await t.runNext() // recovers (ok) → schedule resets
    // A fresh drop must climb the full budget again (3 retries before "lost").
    d.onDrop()
    await t.runNext()
    await t.runNext()
    await t.runNext()
    const lostCount = phases.filter((p) => p === "lost").length
    const reconnectingCount = phases.filter((p) => p === "reconnecting").length
    expect(lostCount).toBe(1)
    expect(reconnectingCount).toBe(4) // 1 (recovered run) + 3 (the full second ladder)
  })

  it("noteConnect (a tab switch) cancels a queued retry and resets the schedule", async () => {
    const t = fakeTimer()
    const connect = vi.fn(async () => ({ error: "down" }))
    const d = createReconnectDriver({
      connect,
      emit: () => {},
      config: CFG,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    })
    d.noteConnect("tab-1")
    d.onDrop()
    expect(t.pendingCount()).toBe(1) // a retry is queued
    d.noteConnect("tab-2") // user switched tabs
    expect(t.pendingCount()).toBe(0) // the queued retry was cancelled
    expect(t.cleared.length).toBe(1)
    // The stale timer firing late (gen mismatch) must NOT re-invoke connect.
    await t.runNext()
    expect(connect).not.toHaveBeenCalled()
  })

  it("stop() cancels a queued retry (host-initiated teardown halts the loop)", () => {
    const t = fakeTimer()
    const connect = vi.fn(async () => ({ error: "down" }))
    const d = createReconnectDriver({
      connect,
      emit: () => {},
      config: CFG,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    })
    d.noteConnect("tab-1")
    d.onDrop()
    expect(t.pendingCount()).toBe(1)
    d.stop()
    expect(t.pendingCount()).toBe(0)
  })

  it("a drop before any connect is terminal 'lost' (nothing to reconnect to)", () => {
    const t = fakeTimer()
    const connect = vi.fn(async () => ({ ok: true }))
    const phases: string[] = []
    const d = createReconnectDriver({
      connect,
      emit: (p) => phases.push(p),
      config: CFG,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    })
    d.onDrop()
    expect(phases).toEqual(["lost"])
    expect(t.pendingCount()).toBe(0)
    expect(connect).not.toHaveBeenCalled()
  })
})

// --- event fan-out (SSE downlink) -----------------------------------------------------

describe("event fan-out (SSE)", () => {
  it("a decoded cdp push reaches every onEvent listener once, in order", () => {
    const cdp = createWebCdp(baseDeps())
    const seen: string[] = []
    cdp.onEvent(() => seen.push("a"))
    cdp.onEvent(() => seen.push("b"))
    const es = FakeEventSource.instances[0]
    es.emit("cdp", JSON.stringify({ method: "Page.loadEventFired" }))
    expect(seen).toEqual(["a", "b"])
  })

  it("a screencast-frame cdp event still fans out (no frame-tunnel filtering active)", () => {
    const cdp = createWebCdp(baseDeps())
    const frames: unknown[] = []
    cdp.onEvent((msg) => frames.push(msg))
    const es = FakeEventSource.instances[0]
    const frame = { method: "Page.screencastFrame", params: { data: "jpeg" } }
    es.emit("cdp", JSON.stringify(frame))
    expect(frames).toEqual([frame])
  })

  it("disconnected reaches every onDisconnected listener once, in order", () => {
    const cdp = createWebCdp(baseDeps())
    const seen: string[] = []
    cdp.onDisconnected(() => seen.push("a"))
    cdp.onDisconnected(() => seen.push("b"))
    FakeEventSource.instances[0].emit("disconnected", "")
    expect(seen).toEqual(["a", "b"])
  })

  it("after a connect, a server 'disconnected' surfaces the 'reconnecting' phase to listeners", async () => {
    const t = fakeTimers()
    const { fetchFn, calls } = makeFakeFetch({ reply: () => ({ ok: true }) })
    const cdp = createWebCdp(
      baseDeps({
        fetch: fetchFn as unknown as typeof fetch,
        setTimer: t.setTimer,
        clearTimer: t.clearTimer,
      }),
    )
    const phases: Array<string | undefined> = []
    cdp.onDisconnected((p) => phases.push(p))
    await cdp.connect("plain-1") // arm the driver with the active tab
    FakeEventSource.instances[0].emit("disconnected", "") // a real host drop
    expect(phases).toEqual(["reconnecting"])
    // The backoff window elapses → the driver re-POSTs /api/connect for the same tab.
    await t.runNext()
    const connectCalls = calls.filter((c) => c.path === "/api/connect")
    expect(connectCalls.length).toBe(2) // the initial connect + one retry
  })

  it("notification reaches every onNotification listener once, in order", () => {
    const cdp = createWebCdp(baseDeps())
    const seen: string[] = []
    cdp.onNotification(() => seen.push("a"))
    cdp.onNotification(() => seen.push("b"))
    FakeEventSource.instances[0].emit("notification", JSON.stringify({ id: "n1" }))
    expect(seen).toEqual(["a", "b"])
  })

  it("notification-activate reaches every onNotificationActivate listener once, in order", () => {
    const cdp = createWebCdp(baseDeps())
    const seen: string[] = []
    cdp.onNotificationActivate(() => seen.push("a"))
    cdp.onNotificationActivate(() => seen.push("b"))
    FakeEventSource.instances[0].emit("notification-activate", JSON.stringify({ id: "n1" }))
    expect(seen).toEqual(["a", "b"])
  })
})

// --- send() Input Forwarding routing --------------------------------------------------

describe("send() routing (POST fallback)", () => {
  it("hover (buttons-up move) is held by the hover gate — no POST until it rests", () => {
    vi.useFakeTimers()
    const { fetchFn, calls } = makeFakeFetch()
    const cdp = createWebCdp(baseDeps({ fetch: fetchFn as unknown as typeof fetch }))
    cdp.send("Input.dispatchMouseEvent", mouseMove(10))
    // Held: nothing flushed yet (no rAF batch, no immediate POST).
    flushRaf()
    expect(calls.filter((c) => c.path === "/api/cdp-batch")).toHaveLength(0)
    // After the 80ms stop delay the gate emits → batcher.coalesce → rAF flush → POST.
    vi.advanceTimersByTime(100)
    flushRaf()
    expect(calls.some((c) => c.path === "/api/cdp-batch")).toBe(true)
    vi.useRealTimers()
  })

  it("drag (button held move) tracks live — coalesced into a batch, gate not used", () => {
    const { fetchFn, calls } = makeFakeFetch()
    const cdp = createWebCdp(baseDeps({ fetch: fetchFn as unknown as typeof fetch }))
    cdp.send("Input.dispatchMouseEvent", mouseMove(20, 1))
    cdp.send("Input.dispatchMouseEvent", mouseMove(30, 1))
    // No gate delay needed — the moves are queued in the batcher immediately.
    flushRaf()
    const batchCalls = calls.filter((c) => c.path === "/api/cdp-batch")
    expect(batchCalls).toHaveLength(1)
    const body = JSON.parse(batchCalls[0].init?.body as string)
    // Coalesced to the latest position only.
    expect(body.items).toEqual([{ method: "Input.dispatchMouseEvent", params: mouseMove(30, 1) }])
  })

  it("mouseWheel accumulates (appended, never collapsed)", () => {
    const { fetchFn, calls } = makeFakeFetch()
    const cdp = createWebCdp(baseDeps({ fetch: fetchFn as unknown as typeof fetch }))
    cdp.send("Input.dispatchMouseEvent", wheel(10))
    cdp.send("Input.dispatchMouseEvent", wheel(20))
    flushRaf()
    const batchCalls = calls.filter((c) => c.path === "/api/cdp-batch")
    expect(batchCalls).toHaveLength(1)
    const body = JSON.parse(batchCalls[0].init?.body as string)
    expect(body.items).toEqual([
      { method: "Input.dispatchMouseEvent", params: wheel(10) },
      { method: "Input.dispatchMouseEvent", params: wheel(20) },
    ])
  })

  it("press/release sends immediately and cancels a held hover", () => {
    vi.useFakeTimers()
    const { fetchFn, calls } = makeFakeFetch()
    const cdp = createWebCdp(baseDeps({ fetch: fetchFn as unknown as typeof fetch }))
    cdp.send("Input.dispatchMouseEvent", mouseMove(10)) // held by gate
    cdp.send("Input.dispatchMouseEvent", press()) // immediate + cancels hover
    flushRaf()
    const batchCalls = calls.filter((c) => c.path === "/api/cdp-batch")
    expect(batchCalls).toHaveLength(1)
    const body = JSON.parse(batchCalls[0].init?.body as string)
    expect(body.items).toEqual([{ method: "Input.dispatchMouseEvent", params: press() }])
    // The held hover was cancelled — advancing past the delay produces nothing more.
    vi.advanceTimersByTime(200)
    flushRaf()
    expect(calls.filter((c) => c.path === "/api/cdp-batch")).toHaveLength(1)
    vi.useRealTimers()
  })

  it("a non-mouse dispatchKeyEvent sends immediately", () => {
    const { fetchFn, calls } = makeFakeFetch()
    const cdp = createWebCdp(baseDeps({ fetch: fetchFn as unknown as typeof fetch }))
    cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a" })
    const batchCalls = calls.filter((c) => c.path === "/api/cdp-batch")
    expect(batchCalls).toHaveLength(1)
    const body = JSON.parse(batchCalls[0].init?.body as string)
    expect(body.items).toEqual([
      { method: "Input.dispatchKeyEvent", params: { type: "keyDown", key: "a" } },
    ])
  })

  it("Page.screencastFrameAck is dropped (server acks frames itself)", () => {
    const { fetchFn, calls } = makeFakeFetch()
    const cdp = createWebCdp(baseDeps({ fetch: fetchFn as unknown as typeof fetch }))
    cdp.send("Page.screencastFrameAck", { sessionId: 1 })
    flushRaf()
    // No input POST results from the ack (the construction-time stream probe is filtered).
    expect(inputPosts(calls)).toHaveLength(0)
  })
})

// --- batch routing across WS / fallback / forced-batch --------------------------------

describe("batch routing", () => {
  it("WS-ready: a flushed batch rides the WS as { t: 'batch' } and not a POST", async () => {
    const { fetchFn, calls } = makeFakeFetch()
    const cdp = createWebCdp(baseDeps({ fetch: fetchFn as unknown as typeof fetch }))
    const ws = FakeWebSocket.instances[0]
    ws.ready() // flips wsReady true (and tears down SSE)
    cdp.send("Input.dispatchMouseEvent", mouseMove(40, 1))
    flushRaf()
    await Promise.resolve()
    // No /api/cdp-batch POST while WS carries it.
    expect(calls.filter((c) => c.path === "/api/cdp-batch")).toHaveLength(0)
    const batchEnvelope = ws.sent.map((s) => JSON.parse(s)).find((m) => m.t === "batch")
    expect(batchEnvelope).toBeDefined()
    expect(batchEnvelope.items).toEqual([
      { method: "Input.dispatchMouseEvent", params: mouseMove(40, 1) },
    ])
  })

  it("WS not ready: the batch goes to the POST fallback", () => {
    const { fetchFn, calls } = makeFakeFetch()
    const cdp = createWebCdp(baseDeps({ fetch: fetchFn as unknown as typeof fetch }))
    // No ws.ready() → wsReady stays false.
    cdp.send("Input.dispatchMouseEvent", mouseMove(50, 1))
    flushRaf()
    expect(calls.some((c) => c.path === "/api/cdp-batch")).toBe(true)
  })

  it("inputTransport=batch pins the single-flight POST fallback even after a stream ack", () => {
    const { fetchFn, calls } = makeFakeFetch()
    const cdp = createWebCdp(
      baseDeps({
        fetch: fetchFn as unknown as typeof fetch,
        localStorage: {
          getItem: (k) => (k === "inputTransport" ? "batch" : null),
          setItem: () => {},
        },
      }),
    )
    // Simulate the streaming channel acking (stream-ack over SSE) — in any other mode this
    // would route subsequent batches through the (already-open) stream instead of POST.
    FakeEventSource.instances[0].emit("stream-ack", "")
    cdp.send("Input.dispatchMouseEvent", mouseMove(60, 1))
    flushRaf()
    // Forced batch mode pins the single-flight POST to /api/cdp-batch despite the ack.
    expect(calls.some((c) => c.path === "/api/cdp-batch")).toBe(true)
  })
})

// --- E2E seal/open round-trip ---------------------------------------------------------

describe("E2E seal/open", () => {
  it("a sealed /api body posts as text/plain and decodes back to the original object", async () => {
    const key = await deriveKey("pw", btoa("0123456789abcdef"), 10000)
    // 204 → postJson returns without decoding a response body; we assert on the request.
    const { fetchFn, calls } = makeFakeFetch({ status: 204 })
    const cdp = createWebCdp(
      baseDeps({ fetch: fetchFn as unknown as typeof fetch, getE2eKey: () => key }),
    )
    await cdp.setConfig({ host: "h", port: 9222 })
    const call = callTo(calls, "/api/config")
    expect((call.init?.headers as Record<string, string>)["Content-Type"]).toBe("text/plain")
    const decoded = await envOpen(call.init?.body as string, key)
    expect(decoded).toEqual({ host: "h", port: 9222 })
  })

  it("a sealed SSE notification decodes back to the original object", async () => {
    const key = await deriveKey("pw", btoa("0123456789abcdef"), 10000)
    const cdp = createWebCdp(baseDeps({ getE2eKey: () => key }))
    const seen: unknown[] = []
    cdp.onNotification((e) => seen.push(e))
    const entry = { id: "n9", title: "hi", body: "there" }
    FakeEventSource.instances[0].emit("notification", await envSeal(entry, key))
    // SSE decode under E2E is serialized through an async chain (WebCrypto decrypt).
    await vi.waitFor(() => expect(seen).toEqual([entry]))
  })

  it("with no key, bodies are plaintext JSON", async () => {
    const { fetchFn, calls } = makeFakeFetch()
    const cdp = createWebCdp(baseDeps({ fetch: fetchFn as unknown as typeof fetch }))
    await cdp.setConfig({ host: "h", port: 9222 })
    const call = callTo(calls, "/api/config")
    expect((call.init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json")
    expect(JSON.parse(call.init?.body as string)).toEqual({ host: "h", port: 9222 })
  })
})

// --- theme push -----------------------------------------------------------------------

function fakeMql(matches: boolean) {
  const listeners: Array<() => void> = []
  return {
    mql: {
      matches,
      addEventListener: (_t: string, cb: () => void) => listeners.push(cb),
      removeEventListener: () => {},
    } as unknown as MediaQueryList,
    listeners,
  }
}

describe("theme push", () => {
  it("setThemeSource('dark') posts isDark:true and notifies onNativeThemeChanged", async () => {
    const { fetchFn, calls } = makeFakeFetch()
    const { mql } = fakeMql(false)
    const cdp = createWebCdp(
      baseDeps({ fetch: fetchFn as unknown as typeof fetch, matchMedia: () => mql }),
    )
    const seen: boolean[] = []
    cdp.onNativeThemeChanged((d) => seen.push(d))
    await cdp.setThemeSource("dark")
    const themeCall = callTo(calls, "/api/theme")
    expect(JSON.parse(themeCall.init?.body as string)).toEqual({ isDark: true })
    expect(seen).toEqual([true])
  })

  it("system source resolves the dark flag from matchMedia", async () => {
    const { fetchFn, calls } = makeFakeFetch({ reply: () => '"system"' })
    const { mql } = fakeMql(true) // system prefers dark
    const cdp = createWebCdp(
      baseDeps({ fetch: fetchFn as unknown as typeof fetch, matchMedia: () => mql }),
    )
    const seen: boolean[] = []
    cdp.onNativeThemeChanged((d) => seen.push(d))
    await cdp.getThemeSource() // resolves source="system" then pushTheme()
    const themeCall = callTo(calls, "/api/theme")
    expect(JSON.parse(themeCall.init?.body as string)).toEqual({ isDark: true })
    expect(seen).toEqual([true])
  })

  it("a matchMedia 'change' re-pushes the resolved flag", async () => {
    const { fetchFn, calls } = makeFakeFetch()
    const { mql, listeners } = fakeMql(true)
    const cdp = createWebCdp(
      baseDeps({ fetch: fetchFn as unknown as typeof fetch, matchMedia: () => mql }),
    )
    const seen: boolean[] = []
    cdp.onNativeThemeChanged((d) => seen.push(d))
    for (const cb of listeners) cb() // fire the mql change handler (pushTheme)
    expect(calls.some((c) => c.path === "/api/theme")).toBe(true)
    expect(seen).toEqual([true])
  })
})

// --- visible-tab WS re-climb (t041) ---------------------------------------------------

describe("visible-tab WS re-climb", () => {
  // Install/restore a fake document so the visibilitychange listener and visibility gate are
  // exercised (the node test env has no document by default).
  let restoreDoc: () => void
  function installDoc(fd: ReturnType<typeof fakeDocument>) {
    const g = globalThis as { document?: unknown }
    const prev = g.document
    g.document = fd.doc
    restoreDoc = () => {
      g.document = prev
    }
  }
  afterEach(() => restoreDoc?.())

  function bootAuto() {
    const fd = fakeDocument()
    installDoc(fd)
    const timers = fakeTimers()
    const { fetchFn } = makeFakeFetch()
    const cdp = createWebCdp(
      baseDeps({
        fetch: fetchFn as unknown as typeof fetch,
        setTimer: timers.setTimer as unknown as (
          cb: () => void,
          ms: number,
        ) => ReturnType<typeof setTimeout>,
        clearTimer: timers.clearTimer,
      }),
    )
    return { fd, timers, cdp }
  }

  it("schedules a spaced re-climb after a ready WS drops while foregrounded", async () => {
    const { timers } = bootAuto()
    const ws0 = FakeWebSocket.instances[0]
    ws0.ready() // WS up
    expect(timers.pendingCount()).toBe(0) // nothing to re-climb while up
    ws0.close() // mid-session blip
    // A re-climb attempt is queued (spaced via the backoff schedule), not fired inline.
    expect(timers.pendingCount()).toBe(1)
    const before = FakeWebSocket.instances.length
    await timers.runNext() // the timer fires → openWs() opens a fresh socket
    expect(FakeWebSocket.instances.length).toBe(before + 1)
  })

  it("re-climbs repeatedly until WS comes back, then stops", async () => {
    const { timers } = bootAuto()
    const ws0 = FakeWebSocket.instances[0]
    ws0.ready()
    ws0.close()
    await timers.runNext() // attempt #1 → new socket (still not ready)
    const ws1 = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]
    ws1.close() // attempt failed → another re-climb queued
    expect(timers.pendingCount()).toBe(1)
    await timers.runNext() // attempt #2 → new socket
    const ws2 = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]
    ws2.ready() // WS heals
    expect(timers.pendingCount()).toBe(0) // no further re-climb once up
  })

  it("goes quiet while backgrounded: a queued re-climb is cancelled on hide, no attempt fires", () => {
    const { fd, timers } = bootAuto()
    const ws0 = FakeWebSocket.instances[0]
    ws0.ready()
    ws0.close() // re-climb queued
    expect(timers.pendingCount()).toBe(1)
    const before = FakeWebSocket.instances.length
    fd.setVisibility("hidden") // backgrounded → cancel the pending re-climb
    expect(timers.pendingCount()).toBe(0)
    expect(FakeWebSocket.instances.length).toBe(before) // no new socket opened while hidden
  })

  it("resumes the re-climb on return to foreground", () => {
    const { fd, timers } = bootAuto()
    const ws0 = FakeWebSocket.instances[0]
    ws0.ready()
    ws0.close()
    fd.setVisibility("hidden") // cancels the queued re-climb
    expect(timers.pendingCount()).toBe(0)
    fd.setVisibility("visible") // foregrounded → re-arm a single re-climb
    expect(timers.pendingCount()).toBe(1)
  })

  it("does not force WS when the user manually picked Basic (batch)", () => {
    const fd = fakeDocument()
    installDoc(fd)
    const timers = fakeTimers()
    const { fetchFn } = makeFakeFetch()
    createWebCdp(
      baseDeps({
        fetch: fetchFn as unknown as typeof fetch,
        localStorage: {
          getItem: (k) => (k === "inputTransport" ? "batch" : null),
          setItem: () => {},
        },
        setTimer: timers.setTimer as unknown as (
          cb: () => void,
          ms: number,
        ) => ReturnType<typeof setTimeout>,
        clearTimer: timers.clearTimer,
      }),
    )
    // Basic never opens WS, so there's nothing to drop — but a foreground transition must not
    // arm a re-climb against the manual non-WS pick.
    fd.setVisibility("hidden")
    fd.setVisibility("visible")
    expect(timers.pendingCount()).toBe(0)
    // And no WS socket was ever opened.
    expect(FakeWebSocket.instances.length).toBe(0)
  })
})
