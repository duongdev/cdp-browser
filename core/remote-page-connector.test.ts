import { beforeEach, describe, expect, it, vi } from "vitest"
// CommonJS backend-agnostic core — both web/server.mjs and (later) main.js consume it.
import { createRemotePageConnector, SCREENCAST_EVERY_NTH_FRAME } from "./remote-page-connector"

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
    this.listeners[ev] ||= []
    this.listeners[ev].push(fn)
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

    it("caps startScreencast with an explicit everyNthFrame from the connector (t054)", async () => {
      const { connector } = makeConnector()

      const { ws } = await connectAndOpen(connector)

      const start = ws.sent.find((c: any) => c.method === "Page.startScreencast")
      expect(start.params.everyNthFrame).toBe(SCREENCAST_EVERY_NTH_FRAME)
      expect(SCREENCAST_EVERY_NTH_FRAME).toBeGreaterThanOrEqual(1)
    })

    it("returns { ok } and reports isConnected after the socket opens", async () => {
      const { connector } = makeConnector()

      const { result } = await connectAndOpen(connector)

      expect(result).toEqual({ ok: true })
      expect(connector.isConnected()).toBe(true)
    })

    it("returns { error } when the resolved tab is not found", async () => {
      const { connector } = makeConnector({
        tabs: [{ id: "other", webSocketDebuggerUrl: "ws://x" }],
      })

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

  describe("switch teardown is silent, real drop is loud", () => {
    it("a second connect supersedes the prior socket without firing onClose (switch is silent)", async () => {
      const closes: number[] = []
      const { connector } = makeConnector()
      connector.onClose(() => closes.push(1))

      const { ws: first } = await connectAndOpen(connector)

      // Switch: a new connect tears the prior socket down. Its close must NOT broadcast.
      const p2 = connector.connect({ tabId: "t1" })
      expect(first.closed).toBe(true)
      await tick()
      const second = FakeWs.instances[FakeWs.instances.length - 1]
      second.open()
      await p2

      expect(closes).toHaveLength(0)
    })

    it("disconnect() closes the active socket silently (no onClose)", async () => {
      const closes: number[] = []
      const { connector } = makeConnector()
      connector.onClose(() => closes.push(1))
      const { ws } = await connectAndOpen(connector)

      connector.disconnect()

      expect(ws.closed).toBe(true)
      expect(closes).toHaveLength(0)
    })

    it("a real drop (the active socket closes on its own) fires onClose exactly once", async () => {
      const closes: number[] = []
      const { connector } = makeConnector()
      connector.onClose(() => closes.push(1))
      const { ws } = await connectAndOpen(connector)

      // The host did not tear this down — the underlying socket dropped.
      ws.close()

      expect(closes).toHaveLength(1)
    })

    it("after a switch, a later real drop of the NEW socket still fires exactly one onClose", async () => {
      const closes: number[] = []
      const { connector } = makeConnector()
      connector.onClose(() => closes.push(1))

      await connectAndOpen(connector)
      // Switch to a fresh socket; the superseded one is silently detached.
      const p2 = connector.connect({ tabId: "t1" })
      await tick()
      const second = FakeWs.instances[FakeWs.instances.length - 1]
      second.open()
      await p2

      // The new active socket drops for real — must surface exactly one disconnect.
      second.close()

      expect(closes).toHaveLength(1)
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
      ctl.connector.setMetricsOverride({
        width: 800,
        height: 600,
        deviceScaleFactor: 1,
        mobile: false,
      })

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
      ctl.connector.setMetricsOverride({
        width: 800,
        height: 600,
        deviceScaleFactor: 1,
        mobile: false,
      })
      ctl.connector.setMetricsOverride(null)

      const { ws } = await connectAndOpen(ctl.connector)

      expect(ws.methods()).not.toContain("Emulation.setDeviceMetricsOverride")
    })
  })

  // The original bug: device-metrics were re-issued on every fresh socket, bouncing
  // the remote host viewport on every tab switch. e968839 tried to fix it by skipping
  // unchanged metrics — but treated send() as "already applied to the new socket",
  // which broke adaptive viewport: the new target had no override and got a big
  // letterbox. The correct fix: reset appliedMetrics on switch teardown so a new
  // target always gets the override. The "skip unchanged" guard still fires for the
  // same-target-reconnect path (where a real drop and re-open uses send() state).
  describe("metrics apply on switch / idempotence on same-target-reconnect", () => {
    it("re-applies the override on every tab switch (new target has no prior override)", async () => {
      const ctl = makeConnector({ uiState: { adaptiveViewport: true } })
      ctl.connector.setMetricsOverride({
        width: 800,
        height: 600,
        deviceScaleFactor: 1,
        mobile: false,
      })

      // First connect applies the override.
      const { ws: ws1 } = await connectAndOpen(ctl.connector)
      expect(ws1.methods()).toContain("Emulation.setDeviceMetricsOverride")

      // Switching to a new target (second connect) — must re-apply even with the same
      // metrics because the new target has no prior override (appliedMetrics was reset
      // during the switch teardown, so sameMetrics check does not skip it).
      const { ws: ws2 } = await connectAndOpen(ctl.connector)
      expect(ws2.methods()).toContain("Emulation.setDeviceMetricsOverride")
    })

    it("DOES re-apply when the metrics actually change between connects (canvas resize)", async () => {
      const ctl = makeConnector({ uiState: { adaptiveViewport: true } })
      ctl.connector.setMetricsOverride({
        width: 800,
        height: 600,
        deviceScaleFactor: 1,
        mobile: false,
      })

      await connectAndOpen(ctl.connector)

      // A real change (e.g. the canvas resized → new adaptive metrics) must still apply.
      ctl.connector.setMetricsOverride({
        width: 1024,
        height: 768,
        deviceScaleFactor: 1,
        mobile: false,
      })
      const { ws: ws2 } = await connectAndOpen(ctl.connector)
      const cmd = ws2.sent.find((c) => c.method === "Emulation.setDeviceMetricsOverride")
      expect(cmd).toBeTruthy()
      expect(cmd.params).toMatchObject({ width: 1024, height: 768 })
    })

    it("fires the adaptive-OFF release dance (override+clear) at most once across multiple connects", async () => {
      const { connector } = makeConnector({ uiState: { adaptiveViewport: false } })

      // First connect: take ownership of any crash-pinned override, then release it.
      const { ws: ws1 } = await connectAndOpen(connector)
      expect(ws1.methods()).toContain("Emulation.setDeviceMetricsOverride")
      expect(ws1.methods()).toContain("Emulation.clearDeviceMetricsOverride")

      // Every subsequent switch: neither override nor clear — the remote stays native,
      // no resize/reflow bounce.
      const { ws: ws2 } = await connectAndOpen(connector)
      expect(ws2.methods()).not.toContain("Emulation.setDeviceMetricsOverride")
      expect(ws2.methods()).not.toContain("Emulation.clearDeviceMetricsOverride")

      const { ws: ws3 } = await connectAndOpen(connector)
      expect(ws3.methods()).not.toContain("Emulation.setDeviceMetricsOverride")
      expect(ws3.methods()).not.toContain("Emulation.clearDeviceMetricsOverride")
    })

    it("does NOT clear the override on a switch teardown (only on a real disconnect)", async () => {
      const ctl = makeConnector({ uiState: { adaptiveViewport: true } })
      ctl.connector.setMetricsOverride({
        width: 800,
        height: 600,
        deviceScaleFactor: 1,
        mobile: false,
      })

      const { ws: ws1 } = await connectAndOpen(ctl.connector)
      // Switching to a new tab tears ws1 down — it must NOT emit a clear (the override
      // is intentionally kept across the switch).
      await connectAndOpen(ctl.connector)
      expect(ws1.methods()).not.toContain("Emulation.clearDeviceMetricsOverride")
    })

    // The latent letterbox: the Adaptive Viewport reducer can emit applyOverride while
    // the socket is mid-reconnect (activeWs null during the t040 backoff window). send()
    // must NOT record that metrics as applied — the remote never received it. Otherwise
    // the subsequent SAME-TARGET reconnect (a real drop nulled activeWs, so connect()
    // runs no switch teardown and never resets appliedMetrics) hits
    // sameMetrics(cachedMetrics, appliedMetrics)===true and SKIPS the override → the
    // remote stays native-size → letterbox.
    it("a setDeviceMetricsOverride sent while the socket is CLOSED is NOT recorded applied → re-applies on the next same-target reconnect", async () => {
      const ctl = makeConnector({ uiState: { adaptiveViewport: true } })

      const { ws: ws1 } = await connectAndOpen(ctl.connector)
      // A real drop: the active socket closes on its own (NOT a switch / disconnect),
      // so connect() later runs no teardown and never resets appliedMetrics.
      ws1.close()
      expect(ctl.connector.isConnected()).toBe(false)

      // The Adaptive Viewport machine emits applyOverride during the backoff window —
      // it lands while activeWs is null, so the remote NEVER receives it.
      ctl.connector.send("Emulation.setDeviceMetricsOverride", {
        width: 800,
        height: 600,
        deviceScaleFactor: 1,
        mobile: false,
      })

      // The same tab reconnects. Because the metrics never actually went out, the
      // reconnect MUST re-issue the override (not skip it as already-applied).
      const { ws: ws2 } = await connectAndOpen(ctl.connector)
      const cmd = ws2.sent.find((c: any) => c.method === "Emulation.setDeviceMetricsOverride")
      expect(cmd).toBeTruthy()
      expect(cmd.params).toMatchObject({ width: 800, height: 600 })
    })

    it("a genuine same-target reconnect where the override DID transmit on an open socket skips the duplicate", async () => {
      const ctl = makeConnector({ uiState: { adaptiveViewport: true } })

      const { ws: ws1 } = await connectAndOpen(ctl.connector)
      // The override transmits on the OPEN socket — the remote actually receives it,
      // so appliedMetrics is stamped.
      ctl.connector.send("Emulation.setDeviceMetricsOverride", {
        width: 800,
        height: 600,
        deviceScaleFactor: 1,
        mobile: false,
      })
      expect(ws1.methods()).toContain("Emulation.setDeviceMetricsOverride")

      // A real drop then a same-target reconnect (no switch teardown, appliedMetrics
      // survives). The metrics are unchanged AND were genuinely applied, so the
      // reconnect must skip the duplicate (no bounce).
      ws1.close()
      const { ws: ws2 } = await connectAndOpen(ctl.connector)
      expect(ws2.methods()).not.toContain("Emulation.setDeviceMetricsOverride")
    })

    it("clears the override on disconnect() and re-applies on the next connect", async () => {
      const ctl = makeConnector({ uiState: { adaptiveViewport: true } })
      ctl.connector.setMetricsOverride({
        width: 800,
        height: 600,
        deviceScaleFactor: 1,
        mobile: false,
      })

      const { ws: ws1 } = await connectAndOpen(ctl.connector)
      ctl.connector.disconnect()
      // A real host-initiated teardown releases the override to native.
      expect(ws1.methods()).toContain("Emulation.clearDeviceMetricsOverride")

      // A fresh connect after a real disconnect re-applies the cached override.
      const { ws: ws2 } = await connectAndOpen(ctl.connector)
      expect(ws2.methods()).toContain("Emulation.setDeviceMetricsOverride")
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
    it("send caches metrics (live-applied) and clears cachedMetrics on clearDeviceMetricsOverride", async () => {
      const { connector } = makeConnector({ uiState: { adaptiveViewport: true } })

      // Connect cold (no cachedMetrics yet), then drive metrics through send() as the
      // Adaptive Viewport machine does — send applies live AND caches them.
      await connectAndOpen(connector)
      connector.send("Emulation.setDeviceMetricsOverride", {
        width: 1024,
        height: 768,
        deviceScaleFactor: 1,
        mobile: false,
      })
      // Switch to a new target: appliedMetrics is reset, so the new target gets the
      // override (correct — the new target has never had it applied).
      const { ws: ws2 } = await connectAndOpen(connector)
      expect(ws2.methods()).toContain("Emulation.setDeviceMetricsOverride")

      // Clear drops the cache; a reconnect then re-applies nothing.
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
