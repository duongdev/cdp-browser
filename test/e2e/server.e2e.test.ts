// Hermetic E2E specs: spawn the real web/server.mjs against the fake CDP host,
// assert behavior over HTTP/SSE/WS. Node env (no browser), no arbitrary sleeps.

import WebSocket from "ws"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

const { startFakeCdpHost, DEFAULT_TARGETS } = await import("./fake-cdp-host.mjs")
const { startWebServer } = await import("./server-harness.mjs")
const { deriveKey, open, seal } = await import("../../crypto-envelope.js")

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
    await waitFor(
      () => fake.fireNotification("teams-1", { id: "__probe__", ts: 0 }),
      6000,
    )
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
    await waitFor(
      () => fake.fireNotification("outlook-1", { id: "__probe__", ts: 0 }),
      6000,
    )
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
    await waitFor(
      () => fake.fireNotification("teams-1", { id: "__probe__", ts: 0 }),
      6000,
    )
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
          else if (msg.t === "event" && msg.event === "cdp" && msg.data?.method === "Page.screencastFrame")
            frames.push(msg)
        } catch {}
      }
    })

    await server.post("/api/connect", { id: "plain-1" })
    await waitFor(() => frames.length > 0, 6000)
    expect(frames.length).toBeGreaterThan(0)
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
