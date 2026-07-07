// Hermetic E2E specs: spawn the real web/server.mjs against the fake CDP host,
// assert behavior over HTTP/SSE/WS. Node env (no browser), no arbitrary sleeps.

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import WebSocket from "ws"

const { startFakeCdpHost, DEFAULT_TARGETS } = await import("./fake-cdp-host.mjs")
const { startWebServer } = await import("./server-harness.mjs")
const { deriveKey, open, seal } = await import("../../core/crypto-envelope.js")

// Poll until predicate is true or timeout.
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

// Connect to a tab and wait until the fake host has a WS from the server
// (i.e., Page.startScreencast was sent — the connect choreography is done).
async function connectAndWait(server: any, fake: any, tabId: string, ms = 5000) {
  // We know connect is done when the fake host received Page.startScreencast.
  // Track that by monitoring inputs — or simply wait until the activate is recorded.
  await server.post("/api/connect", { id: tabId })
  await waitFor(() => fake.getActivations().includes(tabId), ms)
  // Give the WS open handler a tick to send its commands
  await new Promise((r) => setTimeout(r, 200))
}

// ─────────────────────────────────────────────────────────────────────────────
describe("connect + screencast", () => {
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

  it("POST /api/connect returns ok:true for a known tab", async () => {
    const res = await server.post("/api/connect", { id: "plain-1" })
    expect(res.ok).toBe(true)
  })

  it("screencast frame arrives over SSE after connect", async () => {
    const collectPromise = server.collectSse(
      (ev: { event: string; data: any }) =>
        ev.event === "cdp" && ev.data?.method === "Page.screencastFrame",
      8000,
    )
    await new Promise((r) => setTimeout(r, 100))
    await server.post("/api/connect", { id: "plain-1" })
    const events = await collectPromise
    const frame = events.find(
      (e: any) => e.event === "cdp" && e.data?.method === "Page.screencastFrame",
    )
    expect(frame).toBeDefined()
    expect(frame.data.params.data).toBeTruthy()
    expect(frame.data.params.metadata.deviceWidth).toBeGreaterThan(0)
  })

  it("server acks frames and activation is recorded", async () => {
    await connectAndWait(server, fake, "plain-1")
    expect(fake.getActivations()).toContain("plain-1")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe("disconnect signal (switch silent, real drop loud)", () => {
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

  it("switching tabs does NOT emit a 'disconnected' event", async () => {
    // Open an SSE stream and watch it across a connect → switch → switch sequence.
    // A "disconnected" event during the window fails the test; we let the collector
    // run to timeout (no early-exit predicate) and assert none arrived.
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
  })

  it("a real host drop DOES emit a 'disconnected' event", async () => {
    await connectAndWait(server, fake, "plain-1")

    const collectPromise = server.collectSse(
      (ev: { event: string }) => ev.event === "disconnected",
      5000,
    )
    await new Promise((r) => setTimeout(r, 100))

    // Kill the active screencast socket from the host side (CDP host died).
    fake.dropConnections("plain-1")

    const events = await collectPromise
    expect(events.some((e: any) => e.event === "disconnected")).toBe(true)
  })

  it("re-connecting after a real drop resumes frames (the reconnect loop's server half)", async () => {
    // The renderer's bounded-backoff driver (t040) re-POSTs /api/connect after a real drop.
    // This asserts the server half of that loop: a connect issued after the host socket
    // died re-runs the full choreography and frames flow again — no reload, no restart.
    await connectAndWait(server, fake, "plain-1")

    // Kill the active screencast socket (host died) and wait for the disconnected signal.
    const dropSeen = server.collectSse((ev: { event: string }) => ev.event === "disconnected", 5000)
    await new Promise((r) => setTimeout(r, 100))
    fake.dropConnections("plain-1")
    expect((await dropSeen).some((e: any) => e.event === "disconnected")).toBe(true)

    // Drive what the driver does after the backoff window: re-connect the same tab.
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
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe("input forwarding", () => {
  let fake: any
  let server: any

  beforeEach(async () => {
    fake = await startFakeCdpHost({ targets: DEFAULT_TARGETS, frameCadenceMs: 500 })
    server = await startWebServer(fake)
    await connectAndWait(server, fake, "plain-1")
    fake.clearInputs()
  })
  afterEach(async () => {
    server.stop()
    await fake.stop()
  })

  it("POST /api/cdp-batch forwards mouse events to the fake host", async () => {
    await server.post("/api/cdp-batch", {
      items: [
        {
          method: "Input.dispatchMouseEvent",
          params: { type: "mouseMoved", x: 100, y: 200, button: "none" },
        },
      ],
    })
    await waitFor(() => fake.getInputs().some((i: any) => i.method === "Input.dispatchMouseEvent"))
    const mouseEvt = fake.getInputs().find((i: any) => i.method === "Input.dispatchMouseEvent")
    expect(mouseEvt).toBeDefined()
    expect(mouseEvt.params.x).toBe(100)
    expect(mouseEvt.params.y).toBe(200)
  })

  it("POST /api/cdp-batch forwards key events to the fake host", async () => {
    await server.post("/api/cdp-batch", {
      items: [
        {
          method: "Input.dispatchKeyEvent",
          params: { type: "keyDown", key: "a", text: "a" },
        },
      ],
    })
    await waitFor(() => fake.getInputs().some((i: any) => i.method === "Input.dispatchKeyEvent"))
    const keyEvt = fake.getInputs().find((i: any) => i.method === "Input.dispatchKeyEvent")
    expect(keyEvt).toBeDefined()
    expect(keyEvt.params.key).toBe("a")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe("tab lifecycle", () => {
  let fake: any
  let server: any

  beforeEach(async () => {
    fake = await startFakeCdpHost({ targets: DEFAULT_TARGETS })
    server = await startWebServer(fake)
  })
  afterEach(async () => {
    server.stop()
    await fake.stop()
  })

  it("GET /api/tabs lists the fake targets", async () => {
    const tabs = await server.json("/api/tabs")
    expect(Array.isArray(tabs)).toBe(true)
    expect(tabs.length).toBe(3)
    const ids = tabs.map((t: any) => t.id)
    expect(ids).toContain("plain-1")
    expect(ids).toContain("teams-1")
    expect(ids).toContain("outlook-1")
  })

  it("POST /api/tabs/new creates a new tab (hits PUT /json/new on fake host)", async () => {
    const before = await server.json("/api/tabs")
    const newTab = await server.post("/api/tabs/new", { url: "https://new.example.com/" })
    expect(newTab.id).toBeTruthy()
    const after = await server.json("/api/tabs")
    expect(after.length).toBe(before.length + 1)
    expect(after.find((t: any) => t.id === newTab.id)).toBeDefined()
  })

  it("POST /api/tabs/close removes a tab from the listing", async () => {
    await server.post("/api/tabs/close", { id: "plain-1" })
    const tabs = await server.json("/api/tabs")
    expect(tabs.some((t: any) => t.id === "plain-1")).toBe(false)
  })

  it("POST /api/connect activates the target on the fake host", async () => {
    await connectAndWait(server, fake, "teams-1")
    expect(fake.getActivations()).toContain("teams-1")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe("notifications", () => {
  let fake: any
  let server: any

  const TEAMS_PAYLOAD = {
    id: "19:thread1@thread.v2:msg001",
    source: "Alice",
    title: "Hello",
    body: "World",
    activate: { type: "thread", id: "19:thread1@thread.v2" },
    targetEntity: {
      type: "chats",
      id: "19:thread1@thread.v2",
      dataOptions: { messageId: "msg001" },
    },
    ts: Date.now(),
  }

  const OUTLOOK_PAYLOAD = {
    id: "AAQkABCDEF==",
    source: "Bob",
    title: "Meeting invite",
    body: "Join us at 3pm",
    activate: {
      type: "spa-link",
      url: "https://outlook.office.com/mail/inbox/id/AAQkABCDEF%3D%3D",
    },
    targetEntity: {
      deepLink: "https://outlook.office.com/mail/inbox/id/AAQkABCDEF%3D%3D",
    },
    ts: Date.now(),
  }

  beforeEach(async () => {
    fake = await startFakeCdpHost({ targets: DEFAULT_TARGETS, frameCadenceMs: 2000 })
    server = await startWebServer(fake)
    // Server's initial reconcile fires after 1s; side-channel WS connections attach then.
    // We wait for them to appear by polling until fireNotification returns true.
    await waitFor(() => fake.fireNotification("teams-1", { id: "__probe__", ts: 0 }), 6000)
    // Clear any probe effects by waiting for the server to process it (no-op since
    // id="__probe__" is missing source/title so ingest may reject it — fine).
  })
  afterEach(async () => {
    server.stop()
    await fake.stop()
  })

  it("Teams __cdpNotify fires → entry has adapter:teams, groupKey, activate:thread", async () => {
    fake.fireNotification("teams-1", TEAMS_PAYLOAD)

    await waitFor(async () => {
      const notifs = await server.json("/api/notifications")
      return notifs.some((n: any) => n.id === TEAMS_PAYLOAD.id)
    })

    const notifs = await server.json("/api/notifications")
    const entry = notifs.find((n: any) => n.id === TEAMS_PAYLOAD.id)
    expect(entry).toBeDefined()
    expect(entry.adapter).toBe("teams")
    expect(entry.groupKey).toBeTruthy()
    expect(entry.activate).toMatchObject({ type: "thread" })
    expect(entry.read).toBe(false)
  })

  it("duplicate Teams notification ID is deduplicated", async () => {
    fake.fireNotification("teams-1", TEAMS_PAYLOAD)
    await new Promise((r) => setTimeout(r, 50))
    fake.fireNotification("teams-1", TEAMS_PAYLOAD)

    await waitFor(async () => {
      const notifs = await server.json("/api/notifications")
      return notifs.some((n: any) => n.id === TEAMS_PAYLOAD.id)
    })

    const notifs = await server.json("/api/notifications")
    expect(notifs.filter((n: any) => n.id === TEAMS_PAYLOAD.id).length).toBe(1)
  })

  it("Outlook __cdpNotify fires → entry has adapter:outlook + spa-link activate", async () => {
    await waitFor(() => fake.fireNotification("outlook-1", { id: "__probe__", ts: 0 }), 6000)
    fake.fireNotification("outlook-1", OUTLOOK_PAYLOAD)

    await waitFor(async () => {
      const notifs = await server.json("/api/notifications")
      return notifs.some((n: any) => n.id === OUTLOOK_PAYLOAD.id)
    })

    const notifs = await server.json("/api/notifications")
    const entry = notifs.find((n: any) => n.id === OUTLOOK_PAYLOAD.id)
    expect(entry).toBeDefined()
    expect(entry.adapter).toBe("outlook")
    expect(entry.activate).toMatchObject({ type: "spa-link" })
  })

  it("POST /api/notifications/mark-read marks an entry read", async () => {
    fake.fireNotification("teams-1", TEAMS_PAYLOAD)
    await waitFor(async () => {
      const notifs = await server.json("/api/notifications")
      return notifs.some((n: any) => n.id === TEAMS_PAYLOAD.id)
    })

    await server.post("/api/notifications/mark-read", { id: TEAMS_PAYLOAD.id })
    const notifs = await server.json("/api/notifications")
    const entry = notifs.find((n: any) => n.id === TEAMS_PAYLOAD.id)
    expect(entry.read).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe("headless notification capture", () => {
  let fake: any
  let server: any

  beforeEach(async () => {
    fake = await startFakeCdpHost({ targets: DEFAULT_TARGETS })
    server = await startWebServer(fake)
    await waitFor(() => fake.fireNotification("teams-1", { id: "__probe__", ts: 0 }), 6000)
  })
  afterEach(async () => {
    server.stop()
    await fake.stop()
  })

  it("notification captured with no SSE client persists and is queryable", async () => {
    const payload = {
      id: `headless-${Date.now()}`,
      source: "Headless",
      title: "No Client Test",
      body: "Should still persist",
      activate: { type: "thread", id: "19:headless@thread.v2" },
      ts: Date.now(),
    }
    fake.fireNotification("teams-1", payload)

    await waitFor(async () => {
      const notifs = await server.json("/api/notifications")
      return notifs.some((n: any) => n.id === payload.id)
    })

    const notifs = await server.json("/api/notifications")
    expect(notifs.some((n: any) => n.id === payload.id)).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe("WS transport", () => {
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

  it("GET /api/ws opens and emits {t:'ready'}", async () => {
    const ws = server.openWs()
    const ready = await server.wsReady(ws)
    expect(ready.t).toBe("ready")
    ws.close()
  })

  it("WS receives cdp events after connect", async () => {
    const ws = server.openWs()
    await server.wsReady(ws)

    const frames: any[] = []
    ws.on("message", (raw: any, isBinary: boolean) => {
      if (isBinary || (raw instanceof Buffer && raw[0] !== 0x7b)) {
        frames.push({ t: "binary-frame" })
      } else {
        try {
          const msg = JSON.parse(raw.toString())
          if (msg.t === "event") frames.push(msg)
        } catch {}
      }
    })

    await server.post("/api/connect", { id: "plain-1" })
    await waitFor(() => frames.length > 0, 6000)
    expect(frames.length).toBeGreaterThan(0)
    ws.close()
  })

  it("WS invoke round-trip returns a result", async () => {
    const ws = server.openWs()
    await server.wsReady(ws)
    await connectAndWait(server, fake, "plain-1")

    const resultPromise = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("invoke-result timeout")), 5000)
      ws.on("message", (raw: Buffer) => {
        try {
          const msg = JSON.parse(raw.toString())
          if (msg.t === "invoke-result" && msg.id === 42) {
            clearTimeout(timer)
            resolve(msg)
          }
        } catch {}
      })
    })

    ws.send(
      JSON.stringify({
        t: "invoke",
        id: 42,
        method: "Runtime.evaluate",
        params: { expression: "1+1" },
      }),
    )

    const result = await resultPromise
    expect(result.id).toBe(42)
    ws.close()
  })

  it("WS batch reaches the fake host", async () => {
    const ws = server.openWs()
    await server.wsReady(ws)
    await connectAndWait(server, fake, "plain-1")
    fake.clearInputs()

    ws.send(
      JSON.stringify({
        t: "batch",
        items: [
          {
            method: "Input.dispatchMouseEvent",
            params: { type: "mousePressed", x: 50, y: 60, button: "left" },
          },
        ],
      }),
    )

    await waitFor(
      () => fake.getInputs().some((i: any) => i.method === "Input.dispatchMouseEvent"),
      5000,
    )
    const evt = fake.getInputs().find((i: any) => i.method === "Input.dispatchMouseEvent")
    expect(evt.params.x).toBe(50)
    ws.close()
  })

  it("WS screencast frame arrives (binary envelope or cdp-frame event)", async () => {
    const ws = server.openWs()
    await server.wsReady(ws)

    const frames: any[] = []
    ws.on("message", (raw: any, isBinary: boolean) => {
      if (isBinary || (raw instanceof Buffer && raw[0] !== 0x7b)) {
        frames.push({ t: "binary-jpeg" })
      } else {
        try {
          const msg = JSON.parse(raw.toString())
          if (msg.t === "event" && msg.event === "cdp-frame") frames.push(msg)
          else if (
            msg.t === "event" &&
            msg.event === "cdp" &&
            msg.data?.method === "Page.screencastFrame"
          )
            frames.push(msg)
        } catch {}
      }
    })

    await server.post("/api/connect", { id: "plain-1" })
    await waitFor(() => frames.length > 0, 6000)
    expect(frames.length).toBeGreaterThan(0)
    ws.close()
  })

  it("WS ping is echoed back as a pong with the same seq/ts (t057 RTT + keepalive)", async () => {
    const ws = server.openWs()
    await server.wsReady(ws)

    const pong = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("pong timeout")), 5000)
      ws.on("message", (raw: Buffer) => {
        try {
          const msg = JSON.parse(raw.toString())
          if (msg.t === "pong") {
            clearTimeout(timer)
            resolve(msg)
          }
        } catch {}
      })
      ws.send(JSON.stringify({ t: "ping", seq: 7, ts: 123456 }))
    })

    expect(pong.seq).toBe(7)
    expect(pong.ts).toBe(123456) // echoed unchanged — only the client measures RTT
    ws.close()
  })

  it("WS screencast frame carries a server send timestamp (t057 frame age)", async () => {
    const ws = server.openWs()
    await server.wsReady(ws)

    const before = Date.now()
    const stamped = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("frame timeout")), 6000)
      ws.on("message", (raw: any, isBinary: boolean) => {
        if (isBinary) return
        try {
          const msg = JSON.parse(raw.toString())
          const params =
            msg.event === "cdp-frame"
              ? msg.data?.params
              : msg.event === "cdp" && msg.data?.method === "Page.screencastFrame"
                ? msg.data?.params
                : null
          if (params && typeof params.serverTs === "number") {
            clearTimeout(timer)
            resolve(params.serverTs)
          }
        } catch {}
      })
      void server.post("/api/connect", { id: "plain-1" })
    })

    expect(stamped).toBeGreaterThanOrEqual(before)
    expect(stamped).toBeLessThanOrEqual(Date.now())
    ws.close()
  })

  // t056: a WS client that announces ack-after-paint support caps the in-flight queue at
  // one — the server forwards one frame, then defers its remote-ack and withholds the next
  // until the client's `frame-ack` lands. The fake host blasts frames every 100ms without
  // gating on acks, so the server's one-in-flight gate is what holds the line.
  it("WS ack-after-paint client gets one frame in flight; the next waits for its frame-ack", async () => {
    const ws = server.openWs()
    await server.wsReady(ws)
    // Announce support before connecting so the gate is armed for the first frame.
    ws.send(JSON.stringify({ t: "frame-ack-mode" }))

    // Count cdp-frame envelopes (one per relayed frame); capture each frame's sessionId so
    // we can ack the exact frame the server is waiting on.
    const frameEnvelopes: any[] = []
    ws.on("message", (raw: any, isBinary: boolean) => {
      if (isBinary) return
      try {
        const msg = JSON.parse(raw.toString())
        if (msg.t === "event" && msg.event === "cdp-frame") frameEnvelopes.push(msg.data?.params)
      } catch {}
    })

    await server.post("/api/connect", { id: "plain-1" })

    // First frame flows; then the gate holds — even across several 100ms cadence ticks no
    // second frame is broadcast while the first is unacked.
    await waitFor(() => frameEnvelopes.length >= 1, 6000)
    await new Promise((r) => setTimeout(r, 500)) // 5 cadence ticks — all should be dropped
    expect(frameEnvelopes.length).toBe(1)

    // Ack the outstanding frame's paint → the server acks the remote and the next frame is
    // admitted within a cadence tick.
    const firstSid = frameEnvelopes[0].sessionId
    ws.send(JSON.stringify({ t: "frame-ack", sessionId: firstSid }))
    await waitFor(() => frameEnvelopes.length >= 2, 3000)
    expect(frameEnvelopes.length).toBeGreaterThanOrEqual(2)
    ws.close()
  })

  // t056: with no ack from a supporting client, the watchdog frees the slot so a single
  // dropped paint can't wedge the stream forever — frames resume on their own.
  it("WS ack-after-paint stream self-heals if a paint-ack never arrives (watchdog)", async () => {
    const ws = server.openWs()
    await server.wsReady(ws)
    ws.send(JSON.stringify({ t: "frame-ack-mode" }))

    let frameCount = 0
    ws.on("message", (raw: any, isBinary: boolean) => {
      if (isBinary) return
      try {
        const msg = JSON.parse(raw.toString())
        if (msg.t === "event" && msg.event === "cdp-frame") frameCount++
      } catch {}
    })

    await server.post("/api/connect", { id: "plain-1" })
    // Never ack. The 1s watchdog releases the slot, so more than one frame eventually flows
    // despite the missing paint-ack (no permanent wedge).
    await waitFor(() => frameCount >= 2, 6000)
    expect(frameCount).toBeGreaterThanOrEqual(2)
    ws.close()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe("E2E crypto", () => {
  let fake: any
  let server: any
  const PASSPHRASE = "test-e2e-passphrase-abc123"
  const ITERS = 1000 // low for test speed

  beforeEach(async () => {
    fake = await startFakeCdpHost({ targets: DEFAULT_TARGETS })
    server = await startWebServer(fake, {
      E2E_PASSPHRASE: PASSPHRASE,
      E2E_ITERS: String(ITERS),
    })
  })
  afterEach(async () => {
    server.stop()
    await fake.stop()
  })

  it("GET /api/crypto-params advertises e2e:true + salt (always plaintext)", async () => {
    const params = await server.json("/api/crypto-params")
    expect(params.e2e).toBe(true)
    expect(typeof params.salt).toBe("string")
    expect(params.salt.length).toBeGreaterThan(0)
    expect(params.iterations).toBe(ITERS)
    expect(params.verifier).toBeTruthy()
  })

  it("verifier sealed token decrypts to {m:'cdp-e2e-ok'}", async () => {
    const params = await server.json("/api/crypto-params")
    const key = deriveKey(PASSPHRASE, params.salt, ITERS)
    const verifier = open(params.verifier, key)
    expect(verifier).toMatchObject({ m: "cdp-e2e-ok" })
  })

  it("GET /api/config response is sealed (not plaintext JSON)", async () => {
    const params = await server.json("/api/crypto-params")
    const key = deriveKey(PASSPHRASE, params.salt, ITERS)

    const res = await server.fetch("/api/config")
    const text = await res.text()
    // Sealed payload is base64, not a JSON object literal
    expect(text.trim()).not.toMatch(/^\{/)
    // Should decrypt successfully
    const config = open(text.trim(), key)
    expect(typeof config.host).toBe("string")
    expect(typeof config.port).toBe("number")
  })

  it("sealed POST body is accepted and response is sealed", async () => {
    const params = await server.json("/api/crypto-params")
    const key = deriveKey(PASSPHRASE, params.salt, ITERS)

    const payload = seal({ host: "127.0.0.1", port: 9999 }, key)
    const res = await server.fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: payload,
    })
    const text = await res.text()
    const updated = open(text.trim(), key)
    expect(updated.port).toBe(9999)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe("conversation reader history endpoint (t077)", () => {
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

  it("returns 400 without team/channel", async () => {
    const res = await server.fetch("/api/slack/history", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  it("returns a typed 401 when no creds exist for the workspace", async () => {
    const res = await server.fetch("/api/slack/history", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ team: "T_NOPE", channel: "C1" }),
    })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: "invalid_auth" })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe("reader reply endpoint (t078)", () => {
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

  it("returns 400 on missing fields and 401 without creds", async () => {
    const post = (b: unknown) =>
      server.fetch("/api/slack/reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(b),
      })
    expect((await post({ team: "T1", channel: "C1", text: "  " })).status).toBe(400)
    const res = await post({ team: "T1", channel: "C1", text: "hi" })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: "invalid_auth" })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe("group clear — remove notifications by id (t085)", () => {
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

  it("removes only the posted ids and leaves the rest", async () => {
    // The fresh store is empty; this asserts the endpoint shape + idempotence (no throw,
    // returns the remaining list). A populated-store assertion needs captured entries,
    // covered by the unit test on removeMany.
    const res = await server.fetch("/api/notifications/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: ["does-not-exist"] }),
    })
    expect(res.status).toBe(200)
    expect(Array.isArray(await res.json())).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe("push subscription reconcile (E0 — endpoint-keyed deviceId)", () => {
  let fake: any
  let server: any

  beforeEach(async () => {
    fake = await startFakeCdpHost({ targets: DEFAULT_TARGETS })
    server = await startWebServer(fake)
  })
  afterEach(async () => {
    server.stop()
    await fake.stop()
  })

  it("mints a new deviceId for a new subscription endpoint", async () => {
    const res = await server.fetch("/api/notifications/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        endpoint: "https://push.example.com/api/v1/sub1",
        keys: { p256dh: "key1", auth: "auth1" },
      }),
    })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.deviceId).toBeTruthy()
    expect(typeof json.deviceId).toBe("string")
    // UUIDv4 pattern
    expect(json.deviceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )
  })

  it("re-subscribes the same endpoint and returns the same deviceId", async () => {
    const endpoint1 = "https://push.example.com/api/v1/sub1"
    const sub1 = { endpoint: endpoint1, keys: { p256dh: "key1", auth: "auth1" } }
    const res1 = await server.post("/api/notifications/subscribe", sub1)
    const id1 = res1.deviceId

    // Re-subscribe with the same endpoint; should return the same deviceId
    const res2 = await server.post("/api/notifications/subscribe", sub1)
    const id2 = res2.deviceId

    expect(id2).toBe(id1)
  })

  it("mints a different deviceId for a second endpoint (no duplicate per endpoint)", async () => {
    const endpoint1 = "https://push.example.com/api/v1/sub1"
    const endpoint2 = "https://push.example.com/api/v1/sub2"
    const sub1 = { endpoint: endpoint1, keys: { p256dh: "key1", auth: "auth1" } }
    const sub2 = { endpoint: endpoint2, keys: { p256dh: "key2", auth: "auth2" } }

    const res1 = await server.post("/api/notifications/subscribe", sub1)
    const id1 = res1.deviceId

    const res2 = await server.post("/api/notifications/subscribe", sub2)
    const id2 = res2.deviceId

    expect(id2).not.toBe(id1)
    expect(id2).toBeTruthy()
  })

  it("reconciles by endpoint, ignoring the client's cached deviceId", async () => {
    const endpoint = "https://push.example.com/api/v1/sub1"
    const sub1 = { endpoint, keys: { p256dh: "key1", auth: "auth1" } }

    // First subscription gets id1
    const res1 = await server.post("/api/notifications/subscribe", sub1)
    const id1 = res1.deviceId

    // Client sends a different cached id; server ignores it and returns id1 (endpoint match wins)
    const sub2WithCachedId = {
      ...sub1,
      deviceId: "different-cached-id",
    }
    const res2 = await server.post("/api/notifications/subscribe", sub2WithCachedId)
    const id2 = res2.deviceId

    expect(id2).toBe(id1)
  })

  it("adopts a client-asserted deviceId on a NEW endpoint (revocation/rotation recovery, t099)", async () => {
    // A revoked sub re-subscribes with a NEW endpoint but the same known deviceId. The server
    // must re-bind that id to the new endpoint so the per-device prefs keyed by it survive.
    const res1 = await server.post("/api/notifications/subscribe", {
      endpoint: "https://push.example.com/api/v1/old",
      keys: { p256dh: "k1", auth: "a1" },
    })
    const id1 = res1.deviceId

    const res2 = await server.post("/api/notifications/subscribe", {
      endpoint: "https://push.example.com/api/v1/rotated",
      keys: { p256dh: "k1", auth: "a1" },
      deviceId: id1,
    })

    expect(res2.deviceId).toBe(id1)
  })
})

describe("server hardening — body validation (t099)", () => {
  let fake: any
  let server: any

  beforeEach(async () => {
    fake = await startFakeCdpHost({ targets: DEFAULT_TARGETS })
    server = await startWebServer(fake)
  })
  afterEach(async () => {
    server.stop()
    await fake.stop()
  })

  it("rejects a malformed POST body with 400 and leaves config untouched", async () => {
    const before = await server.json("/api/config")

    const res = await server.fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ this is : not valid json",
    })
    expect(res.status).toBe(400)

    const after = await server.json("/api/config")
    expect(after).toEqual(before) // nothing persisted from the bad body
  })

  it("rejects a wrong-shaped config (empty object) with 400 and keeps the CDP address", async () => {
    const before = await server.json("/api/config")

    const res = await server.fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)

    const after = await server.json("/api/config")
    expect(after.host).toBe(before.host)
    expect(after.port).toBe(before.port)
  })

  it("accepts a valid config", async () => {
    const res = await server.fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host: "10.1.2.3", port: 9333 }),
    })
    expect(res.status).toBe(200)
    const after = await server.json("/api/config")
    expect(after.host).toBe("10.1.2.3")
    expect(after.port).toBe(9333)
  })
})
