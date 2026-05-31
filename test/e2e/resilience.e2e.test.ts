// Hermetic E2E for the never-stuck chain (t061): the four resilience guarantees the
// daily driver leans on, proven end-to-end against the fake CDP host (no real browser).
//   1. Transport fallback — WS path streams a frame + input; with WS unused the client
//      falls back to SSE+POST and STILL streams a frame + input reaches the host.
//   2. Real-drop auto-reconnect — a mid-session host drop is seen, the session self-heals
//      when the host returns (frames + input resume), with exactly ONE live socket after.
//   3. WS re-climb after a blip — a dropped WS subscriber re-climbs to WS (frames + input
//      return) with no leaked second socket. (See the describe's note on the WS-blip seam.)
//   4. Tab switch is silent — an intentional switch emits NO user-visible `disconnected`.
// Polls predicates / drives the existing wait helpers; no arbitrary sleeps.

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type WebSocket from "ws"

const { startFakeCdpHost, DEFAULT_TARGETS } = await import("./fake-cdp-host.mjs")
const { startWebServer } = await import("./server-harness.mjs")

// Poll until predicate is true or timeout (mirrors server.e2e.test.ts).
function waitFor(fn: () => boolean | Promise<boolean>, ms = 5000, interval = 80): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = async () => {
      try {
        if (await fn()) return resolve()
      } catch {}
      if (Date.now() - start > ms) return reject(new Error("waitFor timeout"))
      setTimeout(tick, interval)
    }
    tick()
  })
}

// Connect to a tab and wait until the connect choreography is done (activate recorded +
// the screencast socket up). Same shape as server.e2e.test.ts's connectAndWait.
async function connectAndWait(server: any, fake: any, tabId: string, ms = 5000) {
  await server.post("/api/connect", { id: tabId })
  await waitFor(() => fake.getActivations().includes(tabId), ms)
  await new Promise((r) => setTimeout(r, 200))
}

// Collect screencast frames off a WS subscriber until `count` arrive (or it rejects on
// timeout via the caller's waitFor). The server sends frames either as a binary JPEG WS
// frame or a JSON cdp/cdp-frame event — both count.
function frameCounter(ws: WebSocket) {
  const frames: unknown[] = []
  ws.on("message", (raw: Buffer, isBinary: boolean) => {
    if (isBinary || (raw instanceof Buffer && raw[0] !== 0x7b)) {
      frames.push({ kind: "binary" })
      return
    }
    try {
      const msg = JSON.parse(raw.toString())
      if (
        (msg.t === "event" && msg.event === "cdp-frame") ||
        (msg.t === "event" && msg.event === "cdp" && msg.data?.method === "Page.screencastFrame")
      ) {
        frames.push(msg)
      }
    } catch {}
  })
  return frames
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Fallback — WS streams a frame + input; with WS unused, SSE+POST does the same.
describe("resilience: transport fallback WS → SSE+POST", () => {
  let fake: any
  let server: any

  beforeEach(async () => {
    fake = await startFakeCdpHost({ targets: DEFAULT_TARGETS, frameCadenceMs: 100 })
    server = await startWebServer(fake)
  })
  afterEach(async () => {
    server.stop()
    await fake.stop()
  })

  it("WS path: a frame streams over WS and an input command reaches the host", async () => {
    const ws = server.openWs()
    await server.wsReady(ws)
    const frames = frameCounter(ws)

    await connectAndWait(server, fake, "plain-1")
    fake.clearInputs()

    await waitFor(() => frames.length > 0, 6000)
    expect(frames.length).toBeGreaterThan(0)

    ws.send(
      JSON.stringify({
        t: "batch",
        items: [
          {
            method: "Input.dispatchMouseEvent",
            params: { type: "mousePressed", x: 11, y: 22, button: "left" },
          },
        ],
      }),
    )
    await waitFor(() =>
      fake.getInputs("plain-1").some((i: any) => i.method === "Input.dispatchMouseEvent"),
    )
    const evt = fake.getInputs("plain-1").find((i: any) => i.method === "Input.dispatchMouseEvent")
    expect(evt.params.x).toBe(11)
    ws.close()
  })

  it("WS unavailable: client falls back to SSE+POST — a frame streams over SSE and a posted input reaches the host", async () => {
    // No /api/ws is opened: this is the renderer steered off WS (the fallback condition).
    // The frame must arrive over SSE and the input must land via the POST/batch path.
    const framePromise = server.collectSse(
      (ev: { event: string; data: any }) =>
        ev.event === "cdp" && ev.data?.method === "Page.screencastFrame",
      8000,
    )
    await new Promise((r) => setTimeout(r, 100))
    await connectAndWait(server, fake, "plain-1")
    fake.clearInputs()

    const events = await framePromise
    expect(
      events.some((e: any) => e.event === "cdp" && e.data?.method === "Page.screencastFrame"),
    ).toBe(true)

    await server.post("/api/cdp-batch", {
      items: [
        {
          method: "Input.dispatchMouseEvent",
          params: { type: "mouseMoved", x: 33, y: 44, button: "none" },
        },
      ],
    })
    await waitFor(() =>
      fake.getInputs("plain-1").some((i: any) => i.method === "Input.dispatchMouseEvent"),
    )
    const evt = fake.getInputs("plain-1").find((i: any) => i.method === "Input.dispatchMouseEvent")
    expect(evt.params.x).toBe(33)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. Real-drop auto-reconnect — drop mid-session, recover when the host returns, one socket.
describe("resilience: real-drop auto-reconnect (self-heal, one socket)", () => {
  let fake: any
  let server: any

  beforeEach(async () => {
    fake = await startFakeCdpHost({ targets: DEFAULT_TARGETS, frameCadenceMs: 100 })
    server = await startWebServer(fake)
  })
  afterEach(async () => {
    server.stop()
    await fake.stop()
  })

  it("drop → disconnected fires → re-connect resumes frames + input, exactly one live socket", async () => {
    await connectAndWait(server, fake, "plain-1")
    expect(fake.liveScreencastCount("plain-1")).toBe(1)

    // A real host drop must surface a user-visible `disconnected` (the reconnect trigger).
    const dropSeen = server.collectSse((ev: { event: string }) => ev.event === "disconnected", 5000)
    await new Promise((r) => setTimeout(r, 100))
    fake.dropConnections("plain-1")
    expect((await dropSeen).some((e: any) => e.event === "disconnected")).toBe(true)
    await waitFor(() => fake.liveScreencastCount("plain-1") === 0, 5000)

    // The renderer's bounded-backoff driver (t040) re-POSTs /api/connect after a real drop.
    // Drive that recovery step here and assert frames resume on the recovered socket.
    const recovered = server.collectSse(
      (ev: { event: string; data: any }) =>
        ev.event === "cdp" && ev.data?.method === "Page.screencastFrame",
      8000,
    )
    await new Promise((r) => setTimeout(r, 100))
    const res = await server.post("/api/connect", { id: "plain-1" })
    expect(res.ok).toBe(true)
    const events = await recovered
    expect(
      events.some((e: any) => e.event === "cdp" && e.data?.method === "Page.screencastFrame"),
    ).toBe(true)

    // No duplicate live socket — exactly one screencast attachment on the recovered target.
    // The connectId race-guard tears down the stale socket before promoting the recovered one.
    await waitFor(() => fake.liveScreencastCount("plain-1") === 1, 5000)
    expect(fake.liveScreencastCount("plain-1")).toBe(1)

    // A fresh input lands on the host again after recovery.
    fake.clearInputs()
    await server.post("/api/cdp-batch", {
      items: [
        {
          method: "Input.dispatchKeyEvent",
          params: { type: "keyDown", key: "b", text: "b" },
        },
      ],
    })
    await waitFor(() =>
      fake.getInputs("plain-1").some((i: any) => i.method === "Input.dispatchKeyEvent"),
    )
    const keyEvt = fake.getInputs("plain-1").find((i: any) => i.method === "Input.dispatchKeyEvent")
    expect(keyEvt.params.key).toBe("b")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. WS re-climb after a blip.
//
// Seam note (per the task's documented allowance): a WS-only blip cannot be isolated from a
// full host drop *inside the fake host* — the host holds one screencast socket shared by all
// SSE/WS subscribers, so dropping it is the real-drop case (covered above). The renderer's
// t041 re-climb is a *client-side* re-`openWs()` after its WS subscriber blips, with the
// Remote Page socket still alive. We drive exactly that composition through the real server:
// open WS → frame → close the WS (the blip) → re-open WS → frames + input return on the fresh
// WS, no reload, and exactly one live screencast socket throughout (the upstream never dropped).
describe("resilience: WS re-climb after a blip", () => {
  let fake: any
  let server: any

  beforeEach(async () => {
    fake = await startFakeCdpHost({ targets: DEFAULT_TARGETS, frameCadenceMs: 100 })
    server = await startWebServer(fake)
  })
  afterEach(async () => {
    server.stop()
    await fake.stop()
  })

  it("WS subscriber blips → re-opened WS resumes frames + input, one upstream socket throughout", async () => {
    await connectAndWait(server, fake, "plain-1")
    expect(fake.liveScreencastCount("plain-1")).toBe(1)

    // First WS subscriber: confirm frames flow.
    const ws1 = server.openWs()
    await server.wsReady(ws1)
    const frames1 = frameCounter(ws1)
    await waitFor(() => frames1.length > 0, 6000)
    expect(frames1.length).toBeGreaterThan(0)

    // The blip: the WS subscriber drops (no reload, upstream Remote Page socket stays up).
    ws1.close()
    await waitFor(() => ws1.readyState === ws1.CLOSED, 3000)

    // Re-climb: a fresh WS comes up and frames + input return on it.
    const ws2 = server.openWs()
    await server.wsReady(ws2)
    const frames2 = frameCounter(ws2)
    await waitFor(() => frames2.length > 0, 6000)
    expect(frames2.length).toBeGreaterThan(0)

    fake.clearInputs()
    ws2.send(
      JSON.stringify({
        t: "batch",
        items: [
          {
            method: "Input.dispatchMouseEvent",
            params: { type: "mousePressed", x: 70, y: 80, button: "left" },
          },
        ],
      }),
    )
    await waitFor(() =>
      fake.getInputs("plain-1").some((i: any) => i.method === "Input.dispatchMouseEvent"),
    )
    const evt = fake.getInputs("plain-1").find((i: any) => i.method === "Input.dispatchMouseEvent")
    expect(evt.params.x).toBe(70)

    // The upstream screencast socket never doubled — a WS subscriber blip is not an upstream drop.
    expect(fake.liveScreencastCount("plain-1")).toBe(1)
    ws2.close()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. Tab switch is silent (t039 guard), contrasted with the real-drop case above.
describe("resilience: tab switch is silent (t039 guard)", () => {
  let fake: any
  let server: any

  beforeEach(async () => {
    fake = await startFakeCdpHost({ targets: DEFAULT_TARGETS, frameCadenceMs: 100 })
    server = await startWebServer(fake)
  })
  afterEach(async () => {
    server.stop()
    await fake.stop()
  })

  it("switching tabs emits NO 'disconnected' (only a real drop does)", async () => {
    // Watch an SSE stream across connect → switch → switch. A `disconnected` in the window
    // fails: there is no early-exit predicate, so the collector runs to its timeout and we
    // assert none arrived. The real-drop describe proves the contrast (a drop IS loud).
    const collectPromise = server.collectSse(
      (ev: { event: string }) => ev.event === "disconnected",
      2500,
    )
    await new Promise((r) => setTimeout(r, 100))

    await connectAndWait(server, fake, "plain-1")
    await connectAndWait(server, fake, "teams-1")
    await connectAndWait(server, fake, "outlook-1")

    const events = await collectPromise
    expect(events.some((e: any) => e.event === "disconnected")).toBe(false)
    // And the switch left exactly one live screencast socket on the final tab.
    expect(fake.liveScreencastCount("outlook-1")).toBe(1)
  })
})
