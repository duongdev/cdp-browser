import { describe, expect, it, vi } from "vitest"
import { type AdvisedMode, createUplinkRouter, type Uplink } from "./uplink-router"

/** A fake Uplink adapter that records its calls and lets a test toggle `isReady`. */
function fakeUplink(initialReady = false) {
  let ready = initialReady
  const closes: number[] = []
  let closeCount = 0
  const adapter: Uplink & {
    setReady(v: boolean): void
    sends: Array<{ method: string; params?: unknown }>
    batches: Array<Array<{ method: string }>>
    invokes: Array<{ method: string; params?: unknown }>
    closeCount(): number
  } = {
    isReady: () => ready,
    send: vi.fn((cmd) => {
      adapter.sends.push(cmd)
    }),
    sendBatch: vi.fn((cmds) => {
      adapter.batches.push(cmds as Array<{ method: string }>)
    }),
    invoke: vi.fn(async (method, params) => {
      adapter.invokes.push({ method, params })
      return { from: method }
    }),
    close: vi.fn(() => {
      closeCount++
      closes.push(closeCount)
    }),
    setReady: (v) => {
      ready = v
    },
    sends: [],
    batches: [],
    invokes: [],
    closeCount: () => closeCount,
  }
  return adapter
}

function build(advised: AdvisedMode, readiness: Partial<Record<AdvisedMode, boolean>> = {}) {
  const ws = fakeUplink(readiness.ws ?? false)
  const stream = fakeUplink(readiness.stream ?? false)
  const batch = fakeUplink(readiness.batch ?? true) // batch (POST) is always available
  let advisedMode = advised
  const router = createUplinkRouter({
    adapters: { ws, stream, batch },
    advise: () => advisedMode,
  })
  return { router, ws, stream, batch, setAdvised: (m: AdvisedMode) => (advisedMode = m) }
}

const cmd = (method: string, params?: unknown) => ({ method, params })

describe("uplink-router — pick()", () => {
  it("returns the advised adapter when it isReady (ws)", () => {
    const { router, ws } = build("ws", { ws: true })
    expect(router.pick()).toBe(ws)
  })

  it("returns the advised adapter when it isReady (stream)", () => {
    const { router, stream } = build("stream", { stream: true })
    expect(router.pick()).toBe(stream)
  })

  it("returns the advised adapter when it isReady (batch)", () => {
    const { router, batch } = build("batch", { batch: true })
    expect(router.pick()).toBe(batch)
  })
})

describe("uplink-router — fall-through WS→stream→batch", () => {
  it("advised ws not ready, stream ready → falls to stream", () => {
    const { router, stream } = build("ws", { ws: false, stream: true })
    expect(router.pick()).toBe(stream)
  })

  it("advised ws not ready, stream not ready → falls to batch", () => {
    const { router, batch } = build("ws", { ws: false, stream: false, batch: true })
    expect(router.pick()).toBe(batch)
  })

  it("advised stream not ready → falls past (skips ws if ws not ready) to batch", () => {
    const { router, batch } = build("stream", { ws: false, stream: false, batch: true })
    expect(router.pick()).toBe(batch)
  })

  it("advised stream, ws also ready → fall-through still honors advised first, not ws", () => {
    // Advised stream is ready, so it wins even though ws is also ready.
    const { router, stream } = build("stream", { ws: true, stream: true })
    expect(router.pick()).toBe(stream)
  })
})

describe("uplink-router — delegation", () => {
  it("send delegates to the picked adapter's send", () => {
    const { router, ws } = build("ws", { ws: true })
    router.send(cmd("Input.dispatchMouseEvent", { type: "mouseMoved" }))
    expect(ws.sends).toEqual([cmd("Input.dispatchMouseEvent", { type: "mouseMoved" })])
  })

  it("sendBatch delegates to the picked adapter's sendBatch", () => {
    const { router, stream } = build("stream", { stream: true })
    const cmds = [cmd("a"), cmd("b")]
    router.sendBatch(cmds)
    expect(stream.batches).toEqual([cmds])
  })

  it("invoke delegates to the picked adapter's invoke and resolves its result", async () => {
    const { router, ws } = build("ws", { ws: true })
    const result = await router.invoke("Page.navigate", { url: "x" })
    expect(ws.invokes).toEqual([{ method: "Page.navigate", params: { url: "x" } }])
    expect(result).toEqual({ from: "Page.navigate" })
  })

  it("delegates to the fallen-to adapter, never dropping the command", () => {
    const { router, batch, ws, stream } = build("ws", { ws: false, stream: false, batch: true })
    router.send(cmd("Input.dispatchKeyEvent"))
    router.sendBatch([cmd("x")])
    expect(ws.sends).toHaveLength(0)
    expect(stream.sends).toHaveLength(0)
    expect(batch.sends).toEqual([cmd("Input.dispatchKeyEvent")])
    expect(batch.batches).toEqual([[cmd("x")]])
  })
})

describe("uplink-router — close()", () => {
  it("closes every owned adapter exactly once", () => {
    const { router, ws, stream, batch } = build("ws", { ws: true })
    router.close()
    expect(ws.closeCount()).toBe(1)
    expect(stream.closeCount()).toBe(1)
    expect(batch.closeCount()).toBe(1)
  })
})

describe("uplink-router — re-point on mode change", () => {
  it("a new advised mode re-points the router at the new adapter", () => {
    const { router, ws, stream, setAdvised } = build("ws", { ws: true, stream: true })
    expect(router.pick()).toBe(ws)
    setAdvised("stream")
    expect(router.pick()).toBe(stream)
    router.send(cmd("after-switch"))
    expect(stream.sends).toEqual([cmd("after-switch")])
    expect(ws.sends).toHaveLength(0)
  })

  it("isReady reflects whether any adapter can carry a command", () => {
    const { router, batch } = build("ws", { ws: false, stream: false, batch: true })
    expect(router.isReady()).toBe(true)
    batch.setReady(false)
    expect(router.isReady()).toBe(false)
  })
})

describe("uplink-router — isReady contract", () => {
  it("isReady is true when the advised adapter is ready", () => {
    const { router } = build("ws", { ws: true })
    expect(router.isReady()).toBe(true)
  })

  it("isReady is true when only a fall-through adapter is ready", () => {
    const { router } = build("ws", { ws: false, stream: false, batch: true })
    expect(router.isReady()).toBe(true)
  })
})
