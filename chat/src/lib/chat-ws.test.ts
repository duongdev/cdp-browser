import { beforeEach, describe, expect, it } from "vitest"
import {
  type ChatWsClient,
  type ChatWsFrame,
  type ChatWsStatus,
  createChatWs,
  WS_LIVENESS_TIMEOUT_MS,
} from "./chat-ws"

const last = <T>(a: T[]): T => a[a.length - 1]

// A minimal fake WebSocket that lets tests drive open/message/close/error deterministically.
class FakeWs {
  static OPEN = 1
  static instances: FakeWs[] = []
  readyState = 0
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(public url: string) {
    FakeWs.instances.push(this)
  }
  send(data: string) {
    this.sent.push(data)
  }
  close() {
    this.readyState = 3
  }
  // test drivers
  open() {
    this.readyState = FakeWs.OPEN
    this.onopen?.()
  }
  emit(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
  drop() {
    this.readyState = 3
    this.onclose?.()
  }
}

interface Timer {
  id: number
  fn: () => void
  ms: number
  cancelled: boolean
}

interface Harness {
  client: ChatWsClient
  frames: ChatWsFrame[]
  statuses: ChatWsStatus[]
  /** Timers still armed (cancelled ones drop out, as they would with a real clearTimeout). */
  readonly timers: Timer[]
  /** Run the oldest armed timer. */
  runTimer(): void
  /** Advance the injected clock (drives the liveness watchdog). */
  advance(ms: number): void
}

function makeHarness(): Harness {
  const frames: ChatWsFrame[] = []
  const statuses: ChatWsStatus[] = []
  const all: Timer[] = []
  let clock = 1_000
  let nextId = 1
  const client = createChatWs({
    onFrame: (f) => frames.push(f),
    onStatus: (s) => statuses.push(s),
    // biome-ignore lint/suspicious/noExplicitAny: fake ws satisfies the used subset
    WebSocketImpl: FakeWs as any,
    setTimer: (fn, ms) => {
      const id = nextId++
      all.push({ id, fn, ms, cancelled: false })
      return id as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer: (h) => {
      const t = all.find((x) => x.id === (h as unknown as number))
      if (t) t.cancelled = true
    },
    now: () => clock,
    url: "ws://test/api/chat/ws",
  })
  return {
    client,
    frames,
    statuses,
    get timers() {
      return all.filter((t) => !t.cancelled)
    },
    runTimer() {
      const t = all.find((x) => !x.cancelled)
      if (!t) return
      t.cancelled = true
      t.fn()
    },
    advance(ms: number) {
      clock += ms
    },
  }
}

beforeEach(() => {
  FakeWs.instances = []
})

describe("createChatWs", () => {
  it("connects and reports online on open", () => {
    const h = makeHarness()
    expect(FakeWs.instances).toHaveLength(1)
    FakeWs.instances[0].open()
    expect(h.statuses).toEqual(["online"])
  })

  it("dispatches parsed frames to onFrame", () => {
    const h = makeHarness()
    const ws = FakeWs.instances[0]
    ws.open()
    ws.emit({ type: "conversation-upsert", service: "teams", conversations: [{ id: "c1" }] })
    ws.emit({ type: "messages-upsert", service: "teams", convId: "c1", messages: [{ id: "m1" }] })
    expect(h.frames.map((f) => f.type)).toEqual(["conversation-upsert", "messages-upsert"])
    expect((h.frames[1] as { convId: string }).convId).toBe("c1")
  })

  it("ignores malformed frames without throwing", () => {
    const h = makeHarness()
    const ws = FakeWs.instances[0]
    ws.open()
    ws.onmessage?.({ data: "not json{" })
    ws.onmessage?.({ data: JSON.stringify(42) })
    expect(h.frames).toHaveLength(0)
  })

  it("sends the focus frame on focus change while open, and re-sends on reconnect", () => {
    const h = makeHarness()
    const ws = FakeWs.instances[0]
    ws.open()
    h.client.setFocus("c1")
    expect(JSON.parse(last(ws.sent))).toEqual({ type: "focus", convId: "c1" })

    // Drop → schedule reconnect → the retry timer opens a fresh socket that re-sends the focus.
    ws.drop()
    expect(h.statuses).toContain("reconnecting")
    h.runTimer()
    const ws2 = FakeWs.instances[1]
    expect(ws2).toBeTruthy()
    ws2.open()
    expect(JSON.parse(last(ws2.sent))).toEqual({ type: "focus", convId: "c1" })
  })

  it("holds focus set before open, then sends it once the socket opens", () => {
    const h = makeHarness()
    const ws = FakeWs.instances[0]
    h.client.setFocus("c9") // before open: nothing sent yet
    expect(ws.sent).toHaveLength(0)
    ws.open() // open re-sends the current focus
    expect(JSON.parse(ws.sent[0])).toEqual({ type: "focus", convId: "c9" })
  })

  it("flips back to reconnecting on drop and schedules a retry", () => {
    const h = makeHarness()
    const ws = FakeWs.instances[0]
    ws.open()
    expect(h.statuses).toEqual(["online"])
    ws.drop()
    expect(last(h.statuses)).toBe("reconnecting")
    expect(h.timers).toHaveLength(1)
    h.runTimer()
    expect(FakeWs.instances).toHaveLength(2)
  })

  it("swallows the server ping frame instead of forwarding it to the app", () => {
    const h = makeHarness()
    const ws = FakeWs.instances[0]
    ws.open()
    ws.emit({ type: "ping", ts: 1 })
    expect(h.frames).toHaveLength(0)
  })

  it("force-reconnects a silent socket once the liveness budget elapses", () => {
    const h = makeHarness()
    const ws = FakeWs.instances[0]
    ws.open()
    expect(last(h.statuses)).toBe("online")

    h.advance(WS_LIVENESS_TIMEOUT_MS)
    h.runTimer() // the watchdog fires: nothing has arrived
    expect(last(h.statuses)).toBe("reconnecting")
    h.runTimer() // the backoff retry
    expect(FakeWs.instances).toHaveLength(2)
  })

  it("keeps a socket alive while frames (incl. pings) keep arriving", () => {
    const h = makeHarness()
    const ws = FakeWs.instances[0]
    ws.open()

    // Two heartbeats inside the budget, then the watchdog checks: still fed → stays online.
    h.advance(20_000)
    ws.emit({ type: "ping", ts: 1 })
    h.advance(20_000)
    ws.emit({ type: "ping", ts: 2 })
    h.advance(5_000)
    h.runTimer()
    expect(h.statuses).toEqual(["online"])
    expect(FakeWs.instances).toHaveLength(1)

    // …and it re-arms, so a later silence still trips it.
    h.advance(WS_LIVENESS_TIMEOUT_MS)
    h.runTimer()
    expect(last(h.statuses)).toBe("reconnecting")
  })

  it("does not double-schedule when the forced close fires onclose late", () => {
    const h = makeHarness()
    const ws = FakeWs.instances[0]
    ws.open()
    h.advance(WS_LIVENESS_TIMEOUT_MS)
    h.runTimer() // watchdog closes the socket and schedules one retry
    ws.drop() // the zombie's close event lands afterwards — handlers are detached
    expect(h.timers).toHaveLength(1)
  })

  it("stops the watchdog after close()", () => {
    const h = makeHarness()
    FakeWs.instances[0].open()
    h.client.close()
    expect(h.timers).toHaveLength(0)
  })

  it("stops reconnecting after close()", () => {
    const h = makeHarness()
    const ws = FakeWs.instances[0]
    ws.open()
    h.client.close()
    ws.drop()
    // close() clears the socket handlers, so a late drop can't schedule a retry.
    expect(h.timers).toHaveLength(0)
  })
})
