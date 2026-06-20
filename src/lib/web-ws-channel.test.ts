import { beforeEach, describe, expect, it, vi } from "vitest"
import type { WebTransportDeps } from "./cdp-web-transport"
import type { CryptoContext } from "./crypto-context"
import { createWsChannel } from "./web-ws-channel"

/** Fake WebSocket: capture outbound sends, drive open/ready/message/binary/close by hand. */
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
  message(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) })
  }
  binary(blob: Blob) {
    this.onmessage?.({ data: blob })
  }
  // biome-ignore lint/suspicious/noExplicitAny: parsed test view of wire frames
  parsed(): any[] {
    return this.sent.map((s) => JSON.parse(s))
  }
}

// Off-mode crypto: seal/open are pass-through JSON (no envelope), mode "off".
const offCrypto = {
  mode: "off",
  contentType: "application/json",
  sealText: async (o: unknown) => JSON.stringify(o),
  openText: async (s: string) => JSON.parse(s),
} as unknown as CryptoContext

function makeDeps(): WebTransportDeps {
  return {
    fetch: vi.fn(),
    EventSource: vi.fn() as unknown as typeof EventSource,
    WebSocket: FakeWebSocket as unknown as typeof WebSocket,
  }
}

function makeChannel() {
  const onEvent = vi.fn()
  const onReady = vi.fn()
  const onClose = vi.fn()
  const onFrameBinary = vi.fn()
  const ch = createWsChannel(makeDeps(), offCrypto, {
    onEvent,
    onReady,
    onClose,
    onFrameBinary,
  })
  const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]
  return { ch, ws, onEvent, onReady, onClose, onFrameBinary }
}

beforeEach(() => {
  FakeWebSocket.instances = []
  ;(globalThis as { location?: unknown }).location = { protocol: "http:", host: "localhost" }
})

describe("createWsChannel", () => {
  it("opens a socket to /api/ws on construction", () => {
    const { ws } = makeChannel()
    expect(ws.url).toContain("/api/ws")
  })

  it("flips ready and opts into the paint-ack gate on the server 'ready'", () => {
    const { ch, ws, onReady } = makeChannel()
    expect(ch.isReady()).toBe(false)

    ws.ready()

    expect(ch.isReady()).toBe(true)
    expect(onReady).toHaveBeenCalled()
    expect(ws.parsed().map((m) => m.t)).toContain("frame-ack-mode")
    ch.close()
  })

  it("sends a CDP command as a {t:'send'} envelope", async () => {
    const { ch, ws } = makeChannel()
    ws.ready()

    await ch.send("Input.dispatchMouseEvent", { x: 1, y: 2 })

    expect(ws.parsed().find((m) => m.t === "send")).toMatchObject({
      method: "Input.dispatchMouseEvent",
      params: { x: 1, y: 2 },
    })
    ch.close()
  })

  it("resolves an invoke when its matching invoke-result arrives", async () => {
    const { ch, ws } = makeChannel()
    ws.ready()

    const p = ch.invoke("Page.getNavigationHistory")
    await Promise.resolve() // let the async seal+send settle so the frame is on the wire
    const inv = ws.parsed().find((m) => m.t === "invoke")
    expect(inv).toMatchObject({ method: "Page.getNavigationHistory" })

    ws.message({ t: "invoke-result", id: inv.id, result: { currentIndex: 0 } })

    await expect(p).resolves.toEqual({ currentIndex: 0 })
    ch.close()
  })

  it("fans out a CDP event to onEvent", () => {
    const { ch, ws, onEvent } = makeChannel()
    ws.ready()

    ws.message({ t: "event", event: "cdp", data: "payload" })

    expect(onEvent).toHaveBeenCalledWith("cdp", "payload")
    ch.close()
  })

  it("pairs a cdp-frame envelope with the following binary message", () => {
    const { ch, ws, onFrameBinary } = makeChannel()
    ws.ready()

    ws.message({
      t: "event",
      event: "cdp-frame",
      data: { method: "Page.screencastFrame", params: { sessionId: 7 } },
    })
    const blob = new Blob(["jpeg"])
    ws.binary(blob)

    expect(onFrameBinary).toHaveBeenCalledWith({
      method: "Page.screencastFrame",
      params: { sessionId: 7, dataBlob: blob },
    })
    ch.close()
  })

  it("calls onClose on a spontaneous socket close", () => {
    const { ws, onClose } = makeChannel()
    ws.ready()

    ws.close()

    expect(onClose).toHaveBeenCalled()
  })

  it("suppresses onClose for an explicit channel close()", () => {
    const { ch, ws, onClose } = makeChannel()
    ws.ready()

    ch.close()

    expect(onClose).not.toHaveBeenCalled()
  })
})
