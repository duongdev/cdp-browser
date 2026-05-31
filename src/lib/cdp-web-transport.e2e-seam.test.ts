/**
 * t023 — the E2E fold. These pin the seam-boundary placement the fold introduces, separate
 * from the t020 characterization suite (which stays untouched): the uplink seals once at the
 * egress regardless of which transport carries it, the downlink opens once before fan-out,
 * and both seams refuse while the handshake is unconfirmed. They drive `createWebCdp` through
 * the same injected fakes — no network, no live Remote Browser.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createWebCdp, type WebTransportDeps } from "./cdp-web-transport"
import { deriveKey, open as envOpen, seal as envSeal } from "./crypto-envelope"

const SALT = btoa("0123456789abcdef")

type SseHandler = (e: { data: string }) => void
class FakeEventSource {
  static instances: FakeEventSource[] = []
  handlers: Record<string, SseHandler[]> = {}
  constructor(public url: string) {
    FakeEventSource.instances.push(this)
  }
  addEventListener(type: string, cb: SseHandler) {
    this.handlers[type] ??= []
    this.handlers[type].push(cb)
  }
  close() {}
  emit(type: string, data: string) {
    for (const cb of this.handlers[type] ?? []) cb({ data })
  }
}

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
  ready() {
    this.readyState = FakeWebSocket.OPEN
    this.onmessage?.({ data: JSON.stringify({ t: "ready" }) })
  }
}

interface FetchCall {
  path: string
  init?: RequestInit
}
function makeFakeFetch(status = 200) {
  const calls: FetchCall[] = []
  const fetchFn = vi.fn(async (input: unknown, init?: RequestInit) => {
    calls.push({ path: String(input), init })
    return {
      status,
      json: async () => ({}),
      text: async () => "{}",
    } as unknown as Response
  })
  return { fetchFn, calls }
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

let rafQueue: Array<() => void> = []
beforeEach(() => {
  FakeEventSource.instances = []
  FakeWebSocket.instances = []
  rafQueue = []
  globalThis.requestAnimationFrame = ((cb: () => void) => {
    rafQueue.push(cb)
    return rafQueue.length
  }) as typeof requestAnimationFrame
  ;(globalThis as { location?: unknown }).location = { protocol: "http:", host: "localhost" }
})
afterEach(() => {
  vi.restoreAllMocks()
})
const flushRaf = () => {
  const q = rafQueue
  rafQueue = []
  for (const cb of q) cb()
}

const move = (x: number, buttons = 1) => ({
  method: "Input.dispatchMouseEvent",
  params: { type: "mouseMoved", x, buttons },
})

describe("t023 — uplink seal placement", () => {
  it("E2E on: a flushed batch posts a sealed /api/cdp-batch body that opens to the items", async () => {
    const key = await deriveKey("pw", SALT, 10000)
    const { fetchFn, calls } = makeFakeFetch(204)
    const cdp = createWebCdp(
      baseDeps({ fetch: fetchFn as unknown as typeof fetch, getE2eKey: () => key }),
    )
    cdp.send("Input.dispatchMouseEvent", move(7).params)
    flushRaf()
    await vi.waitFor(() => expect(calls.some((c) => c.path === "/api/cdp-batch")).toBe(true))
    const batchCall = calls.find((c) => c.path === "/api/cdp-batch")
    if (!batchCall) throw new Error("no batch")
    // Sealed: posted as text/plain and opens back to { seq, items }.
    expect((batchCall.init?.headers as Record<string, string>)["Content-Type"]).toBe("text/plain")
    const opened = (await envOpen(batchCall.init?.body as string, key)) as {
      seq: number
      items: unknown[]
    }
    expect(opened.items).toEqual([move(7)])
  })

  it("E2E off: a flushed batch posts plaintext JSON (no seal)", () => {
    const { fetchFn, calls } = makeFakeFetch()
    const cdp = createWebCdp(baseDeps({ fetch: fetchFn as unknown as typeof fetch }))
    cdp.send("Input.dispatchMouseEvent", move(8).params)
    flushRaf()
    const batchCall = calls.find((c) => c.path === "/api/cdp-batch")
    if (!batchCall) throw new Error("no batch")
    expect(JSON.parse(batchCall.init?.body as string).items).toEqual([move(8)])
  })
})

describe("t023 — uplink single-seam routing (seal precedes transport pick)", () => {
  it("WS ready: the batch rides the socket sealed as one envelope, never a per-transport reseal", async () => {
    const key = await deriveKey("pw", SALT, 10000)
    const { fetchFn, calls } = makeFakeFetch()
    const cdp = createWebCdp(
      baseDeps({ fetch: fetchFn as unknown as typeof fetch, getE2eKey: () => key }),
    )
    const ws = FakeWebSocket.instances[0]
    ws.ready()
    cdp.send("Input.dispatchMouseEvent", move(9).params)
    flushRaf()
    // Ping frames (t057 keepalive) are plaintext `{"t":"ping",…}`; the sealed batch is base64
    // (no leading `{`). Wait for the sealed frame, ignoring the always-on ping traffic.
    const isSealed = (s: string) => !s.trimStart().startsWith("{")
    await vi.waitFor(() => expect(ws.sent.some(isSealed)).toBe(true))
    // No POST: the batch went out the one ready uplink (WS), sealed exactly once.
    expect(calls.some((c) => c.path === "/api/cdp-batch")).toBe(false)
    // The WS frame is a single sealed envelope that opens to the routing message { t, items }.
    const sealed = ws.sent.filter(isSealed)
    const opened = (await envOpen(sealed[sealed.length - 1], key)) as {
      t: string
      items: unknown[]
    }
    expect(opened.t).toBe("batch")
    expect(opened.items).toEqual([move(9)])
  })
})

describe("t023 — dispatcher open placement", () => {
  it("a sealed SSE event is opened once before fan-out to every onEvent listener", async () => {
    const key = await deriveKey("pw", SALT, 10000)
    const cdp = createWebCdp(baseDeps({ getE2eKey: () => key }))
    const seen: unknown[] = []
    cdp.onEvent((m) => seen.push(m))
    const frame = { method: "Page.screencastFrame", params: { data: "jpeg" } }
    FakeEventSource.instances[0].emit("cdp", await envSeal(frame, key))
    await vi.waitFor(() => expect(seen).toEqual([frame]))
  })
})

describe("t023 — handshake gate (wired to crypto.ready)", () => {
  // The gate's refuse-until-confirmed semantics are unit-tested on the CryptoContext
  // (`crypto-context.test.ts`: `ready` defaults true at build, `confirm()` flips it). At the
  // seam level the shim's context is always ready (bootstrapE2E confirms before build), so
  // here we pin the positive: once confirmed, both seams pass through.
  it("uplink: a control send crosses the egress gate to /api/send", () => {
    const { fetchFn, calls } = makeFakeFetch()
    const cdp = createWebCdp(baseDeps({ fetch: fetchFn as unknown as typeof fetch }))
    cdp.send("Page.bringToFront", {})
    expect(calls.some((c) => c.path === "/api/send")).toBe(true)
  })

  it("downlink: a plaintext event crosses the ingress gate to its listeners", () => {
    const cdp = createWebCdp(baseDeps())
    const seen: unknown[] = []
    cdp.onEvent((m) => seen.push(m))
    FakeEventSource.instances[0].emit("cdp", JSON.stringify({ method: "Page.loadEventFired" }))
    expect(seen).toEqual([{ method: "Page.loadEventFired" }])
  })
})

describe("web push — the SW-message path preserves the activate intent (regression)", () => {
  // A Teams/Outlook push clicked on a backgrounded PWA reaches the page as a
  // serviceWorker 'message' ({ type: 'notification-click', data }). The handler must
  // reconstruct an entry carrying `activate` (+ groupKey/adapter/targetId) so the
  // activation registry can deep-open the thread. If any hand-picked field list on the
  // push chain (server payload, sw.js data, this handler) re-narrows and drops `activate`,
  // push deep-open silently breaks while the in-app path still works — this guards it.
  it("forwards activate/groupKey/adapter/targetId to notification-activate listeners", () => {
    let msgHandler: ((e: { data: unknown }) => void) | undefined
    const fakeNavigator = {
      serviceWorker: {
        addEventListener: (type: string, cb: (e: { data: unknown }) => void) => {
          if (type === "message") msgHandler = cb
        },
      },
    }
    vi.stubGlobal("navigator", fakeNavigator)
    try {
      const cdp = createWebCdp(baseDeps())
      const seen: CdpNotification[] = []
      cdp.onNotificationActivate((e) => seen.push(e))
      const activate = { type: "thread", id: "19:abc@thread.v2" } as const
      msgHandler?.({
        data: {
          type: "notification-click",
          data: {
            id: "n1",
            source: "Microsoft Teams",
            title: "Alice",
            body: "ping",
            targetId: "tab-7",
            targetUrl: "https://teams.microsoft.com/v2/",
            adapter: "teams",
            groupKey: "https://teams.microsoft.com",
            activate,
          },
        },
      })
      expect(seen).toHaveLength(1)
      expect(seen[0].activate).toEqual(activate)
      expect(seen[0].groupKey).toBe("https://teams.microsoft.com")
      expect(seen[0].adapter).toBe("teams")
      expect(seen[0].targetId).toBe("tab-7")
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
