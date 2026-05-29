/**
 * Characterization tests (t020) — pin the web shim's *current* observable behavior before
 * the Downlink/Uplink seam split (021-023). They drive `createWebCdp` through injected
 * fakes for fetch / EventSource / WebSocket (and matchMedia / localStorage / e2eKey), with
 * no real network and no live Remote Browser. Assertions are against the observable
 * contract — which listeners fire, which envelope/POST goes out, what the seal produces —
 * never private state, so a behavior-preserving refactor keeps them green.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { collapseMoves, createWebCdp, type WebTransportDeps } from "./cdp-web-transport"
import { deriveKey, open as envOpen, seal as envSeal } from "./crypto-envelope"

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
