import { beforeEach, describe, expect, it, vi } from "vitest"
// CommonJS backend-agnostic core — both web/server.mjs and (later) main.js consume it.
import { createRemotePageConnector } from "./remote-page-connector"

// A fake `ws`-shaped socket: records sent CDP commands and lets a test drive
// open/message/close/error like the real `ws` EventEmitter surface. `OPEN`/readyState
// mirror ws so the connector's wsOpen check works.
class FakeWs {
  url: string
  sent: any[] = []
  closed = false
  listeners: Record<string, ((...a: any[]) => void)[]> = {}
  static OPEN = 1
  readyState = 1
  constructor(url: string) {
    this.url = url
    FakeWs.instances.push(this)
  }
  static instances: FakeWs[] = []
  on(ev: string, fn: (...a: any[]) => void) {
    ;(this.listeners[ev] ||= []).push(fn)
    return this
  }
  off(ev: string, fn: (...a: any[]) => void) {
    this.listeners[ev] = (this.listeners[ev] || []).filter((f) => f !== fn)
    return this
  }
  emit(ev: string, ...args: any[]) {
    for (const fn of this.listeners[ev] || []) fn(...args)
  }
  send(raw: string) {
    this.sent.push(JSON.parse(raw))
  }
  close() {
    if (this.closed) return
    this.closed = true
    this.emit("close")
  }
  // Test helpers
  open() {
    this.emit("open")
  }
  deliver(msg: any) {
    this.emit("message", Buffer.from(JSON.stringify(msg)))
  }
  methods() {
    return this.sent.map((c) => c.method)
  }
}

const TAB_WS = (id: string) => `ws://host:9222/devtools/page/${id}`

// Default deps: a transport that returns a fresh FakeWs, /json endpoints that
// resolve a tab carrying its WS url, and a settings reader (theme sync off, no
// adaptive viewport unless overridden).
function makeConnector(over: Partial<any> = {}) {
  FakeWs.instances = []
  const activated: string[] = []
  let uiState = { syncTheme: false, adaptiveViewport: false, ...(over.uiState || {}) }
  const tabsList = over.tabs || [{ id: "t1", webSocketDebuggerUrl: TAB_WS("t1") }]
  const deps = {
    // The connector opens a socket via this; default returns a recordable FakeWs.
    transport: over.transport || ((url: string) => new FakeWs(url)),
    endpoints: {
      activate: (host: string, port: number, id: string) => ({
        url: `http://${host}:${port}/json/activate/${id}`,
        method: "GET",
      }),
    },
    config: () => ({ host: "host", port: 9222 }),
    // settings reader the connector consults for theme + adaptive-viewport gating.
    uiState: () => uiState,
    themeDark: over.themeDark ?? (() => false),
    // injected fetch/activate so no real I/O happens in tests.
    activate: vi.fn(async (desc: any) => {
      activated.push(desc.url)
    }),
    listTargets: vi.fn(async () => tabsList),
    // The 200ms settle wait between activate and list — injected so tests resolve
    // immediately without timers.
    settle: over.settle || (() => Promise.resolve()),
    ...over.deps,
  }
  const connector = createRemotePageConnector(deps)
  return {
    connector,
    deps,
    activated,
    setUiState: (s: any) => {
      uiState = { ...uiState, ...s }
    },
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

// connect, wait for the socket to be created (activate/settle/list are microtasks),
// open it, await resolution, and return both the result and the socket.
async function connectAndOpen(connector: any, tabId = "t1") {
  const p = connector.connect({ tabId })
  await tick()
  const ws = FakeWs.instances[FakeWs.instances.length - 1]
  ws.open()
  const result = await p
  return { result, ws }
}

describe("createRemotePageConnector", () => {
  beforeEach(() => {
    FakeWs.instances = []
  })

  describe("connect choreography", () => {
    it("issues activate → resolve → open → Page.enable + Input.enable → theme → metrics → startScreencast in order", async () => {
      const { connector, activated } = makeConnector({ uiState: { syncTheme: true } })

      const { ws } = await connectAndOpen(connector)

      expect(activated).toEqual(["http://host:9222/json/activate/t1"])
      const methods = ws.methods()
      const idx = (m: string) => methods.indexOf(m)
      expect(idx("Page.enable")).toBeGreaterThanOrEqual(0)
      expect(idx("Page.enable")).toBeLessThan(idx("Input.enable"))
      expect(idx("Input.enable")).toBeLessThan(idx("Emulation.setEmulatedMedia"))
      expect(idx("Emulation.setEmulatedMedia")).toBeLessThan(idx("Page.startScreencast"))
    })

    it("returns { ok } and reports isConnected after the socket opens", async () => {
      const { connector } = makeConnector()

      const { result } = await connectAndOpen(connector)

      expect(result).toEqual({ ok: true })
      expect(connector.isConnected()).toBe(true)
    })

    it("returns { error } when the resolved tab is not found", async () => {
      const { connector } = makeConnector({ tabs: [{ id: "other", webSocketDebuggerUrl: "ws://x" }] })

      const result = await connector.connect({ tabId: "t1" })

      expect(result.error).toBeTruthy()
      expect(connector.isConnected()).toBe(false)
    })
  })

  describe("single Remote Page invariant (ADR-0001)", () => {
    it("closes the prior socket before promoting the new one", async () => {
      const { connector } = makeConnector()

      const { ws: first } = await connectAndOpen(connector)

      const p2 = connector.connect({ tabId: "t1" })
      // The prior socket is closed synchronously at the top of the new connect.
      expect(first.closed).toBe(true)
      await tick()
      const second = FakeWs.instances[FakeWs.instances.length - 1]
      second.open()
      await p2

      expect(connector.isConnected()).toBe(true)
      expect(second.closed).toBe(false)
    })
  })

  describe("connectId race-guard", () => {
    it("discards an older in-flight connect whose socket opens after a newer connect started", async () => {
      const events: any[] = []
      const { connector } = makeConnector()
      connector.onEvent((m: any) => events.push(m))

      // Start the first connect and let it reach socket creation (settle + list
      // resolve as microtasks) — but DON'T open its socket: it is in flight.
      const p1 = connector.connect({ tabId: "t1" })
      await tick()
      const first = FakeWs.instances[0]
      expect(first).toBeTruthy()

      // A newer connect supersedes it (also reaches socket creation).
      const p2 = connector.connect({ tabId: "t1" })
      await tick()
      const second = FakeWs.instances[1]
      expect(second).toBeTruthy()

      // The OLDER socket opens late — must be closed and never promoted.
      first.open()
      const r1 = await p1
      expect(r1.error).toBeTruthy()
      expect(first.closed).toBe(true)

      second.open()
      await p2

      // A frame from the stale (older) socket must NOT be emitted.
      first.deliver({ method: "Page.screencastFrame", params: { sessionId: 1, data: "x" } })
      expect(events).toHaveLength(0)

      // A frame from the active (newer) socket IS emitted.
      second.deliver({ method: "Page.screencastFrame", params: { sessionId: 2, data: "y" } })
      expect(events).toHaveLength(1)
    })
  })

  describe("metrics re-apply on reconnect (ADR-0002)", () => {
    it("re-applies the cached device-metrics override before startScreencast when adaptive viewport is on", async () => {
      const ctl = makeConnector({ uiState: { adaptiveViewport: true } })
      ctl.connector.setMetricsOverride({ width: 800, height: 600, deviceScaleFactor: 1, mobile: false })

      const { ws } = await connectAndOpen(ctl.connector)

      const methods = ws.methods()
      const metricsIdx = methods.indexOf("Emulation.setDeviceMetricsOverride")
      expect(metricsIdx).toBeGreaterThanOrEqual(0)
      expect(metricsIdx).toBeLessThan(methods.indexOf("Page.startScreencast"))
      const metricsCmd = ws.sent.find((c) => c.method === "Emulation.setDeviceMetricsOverride")
      expect(metricsCmd.params).toMatchObject({ width: 800, height: 600 })
    })

    it("re-applies nothing when the override is cleared (adaptive viewport dormant)", async () => {
      const ctl = makeConnector({ uiState: { adaptiveViewport: true } })
      ctl.connector.setMetricsOverride({ width: 800, height: 600, deviceScaleFactor: 1, mobile: false })
      ctl.connector.setMetricsOverride(null)

      const { ws } = await connectAndOpen(ctl.connector)

      expect(ws.methods()).not.toContain("Emulation.setDeviceMetricsOverride")
    })
  })

  describe("disconnect", () => {
    it("closes the active socket and reports not connected", async () => {
      const { connector } = makeConnector()
      const { ws } = await connectAndOpen(connector)

      connector.disconnect()

      expect(ws.closed).toBe(true)
      expect(connector.isConnected()).toBe(false)
    })

    it("cancels an in-flight connect so its late-opening socket is closed and never promoted", async () => {
      const { connector } = makeConnector()
      const p = connector.connect({ tabId: "t1" })
      await tick()
      const ws = FakeWs.instances[0]

      connector.disconnect()

      ws.open()
      const r = await p
      expect(r.error).toBeTruthy()
      expect(ws.closed).toBe(true)
      expect(connector.isConnected()).toBe(false)
    })

    it("fires no onEvent or onClose after teardown (clean teardown, no stale listeners)", async () => {
      const events: any[] = []
      const closes: number[] = []
      const { connector } = makeConnector()
      connector.onEvent((m: any) => events.push(m))
      connector.onClose(() => closes.push(1))

      const { ws } = await connectAndOpen(connector)

      connector.disconnect()
      events.length = 0
      closes.length = 0

      // The torn-down socket emitting late must not reach host callbacks.
      ws.deliver({ method: "Page.screencastFrame", params: { sessionId: 1 } })
      ws.emit("close")
      expect(events).toHaveLength(0)
      expect(closes).toHaveLength(0)
    })
  })

  describe("open failure", () => {
    it("surfaces a transport error without leaving a half-attached active socket", async () => {
      const { connector } = makeConnector()

      const p = connector.connect({ tabId: "t1" })
      await tick()
      const ws = FakeWs.instances[0]
      ws.emit("error", new Error("refused"))
      const result = await p

      expect(result.error).toMatch(/refused/)
      expect(connector.isConnected()).toBe(false)
    })
  })

  describe("send / invoke / setMetricsOverride bookkeeping", () => {
    it("send caches a setDeviceMetricsOverride and clears it on clearDeviceMetricsOverride", async () => {
      const { connector } = makeConnector({ uiState: { adaptiveViewport: true } })

      // Connect, then drive metrics through send() as the Adaptive Viewport machine does.
      await connectAndOpen(connector)

      connector.send("Emulation.setDeviceMetricsOverride", {
        width: 1024,
        height: 768,
        deviceScaleFactor: 1,
        mobile: false,
      })

      // Reconnect: the cached override must be re-applied.
      const { ws: ws2 } = await connectAndOpen(connector)
      expect(
        ws2.sent.find((c) => c.method === "Emulation.setDeviceMetricsOverride").params,
      ).toMatchObject({
        width: 1024,
        height: 768,
      })

      // Clear, reconnect again: nothing re-applied.
      connector.send("Emulation.clearDeviceMetricsOverride", {})
      const { ws: ws3 } = await connectAndOpen(connector)
      expect(ws3.methods()).not.toContain("Emulation.setDeviceMetricsOverride")
    })

    it("invoke resolves the matching CDP response id", async () => {
      const { connector } = makeConnector()
      const { ws } = await connectAndOpen(connector)

      const inv = connector.invoke("Page.getNavigationHistory", {})
      const sentId = ws.sent.find((c) => c.method === "Page.getNavigationHistory").id
      ws.deliver({ id: sentId, result: { entries: [] } })

      await expect(inv).resolves.toEqual({ entries: [] })
    })

    it("invoke returns { error } when not connected", async () => {
      const { connector } = makeConnector()
      await expect(connector.invoke("Page.reload", {})).resolves.toEqual({ error: "not connected" })
    })
  })

  describe("applyTheme", () => {
    it("re-applies emulated media to the live socket when the theme changes mid-session", async () => {
      let dark = false
      const ctl = makeConnector({ uiState: { syncTheme: true }, themeDark: () => dark })
      const { ws } = await connectAndOpen(ctl.connector)

      dark = true
      ctl.connector.applyTheme()

      const last = [...ws.sent].reverse().find((c) => c.method === "Emulation.setEmulatedMedia")
      expect(last.params.features[0]).toMatchObject({ name: "prefers-color-scheme", value: "dark" })
    })

    it("is a no-op when not connected", () => {
      const { connector } = makeConnector()
      expect(() => connector.applyTheme()).not.toThrow()
    })
  })
})
