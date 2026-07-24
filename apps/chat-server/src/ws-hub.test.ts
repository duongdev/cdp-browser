import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import Database from "better-sqlite3"
import { afterAll, beforeEach, describe, expect, test } from "vitest"
import WebSocket from "ws"
import type { ChatWsServerMessage } from "./contract.ts"
import { migrate, upsertConversations } from "./store.ts"
import {
  attachWsHub,
  broadcast,
  buildSnapshot,
  getFocusedConvIds,
  type HubSocket,
  HubState,
} from "./ws-hub.ts"

function freshDb() {
  return migrate(new Database(":memory:"))
}

/** A recording fake socket satisfying HubSocket. */
function fakeSocket(over: Partial<HubSocket> = {}): HubSocket & { sent: string[]; killed: number } {
  const sent: string[] = []
  return {
    sent,
    killed: 0,
    send(d: string) {
      sent.push(d)
    },
    terminate() {
      this.killed++
    },
    bufferedAmount: 0,
    ...over,
  }
}

describe("buildSnapshot", () => {
  test("emits a conversation-upsert of the store list", () => {
    const db = freshDb()
    upsertConversations(db, "teams", [
      { id: "19:a@thread.v2", kind: "group", lastMessageVersion: 1, lastMessageTs: 100 },
    ])
    const frames = buildSnapshot(db, "teams")
    expect(frames).toHaveLength(1)
    expect(frames[0].type).toBe("conversation-upsert")
    const f = frames[0] as Extract<ChatWsServerMessage, { type: "conversation-upsert" }>
    expect(f.conversations.map((c) => c.id)).toEqual(["19:a@thread.v2"])
  })
})

describe("HubState", () => {
  let db: ReturnType<typeof freshDb>
  beforeEach(() => {
    db = freshDb()
    upsertConversations(db, "teams", [
      { id: "19:a@thread.v2", kind: "group", lastMessageVersion: 1, lastMessageTs: 100 },
    ])
  })

  test("add() snapshots the new client", () => {
    const hub = new HubState(db)
    const s = fakeSocket()
    hub.add(s)
    expect(hub.clients.has(s)).toBe(true)
    expect(s.sent).toHaveLength(1)
    expect(JSON.parse(s.sent[0]).type).toBe("conversation-upsert")
  })

  test("focus tracking dedups + drops nulls", () => {
    const hub = new HubState(db)
    const a = fakeSocket()
    const b = fakeSocket()
    hub.add(a)
    hub.add(b)
    hub.onMessage(a, JSON.stringify({ type: "focus", convId: "19:a@thread.v2" }))
    hub.onMessage(b, JSON.stringify({ type: "focus", convId: "19:a@thread.v2" }))
    expect(hub.getFocusedConvIds()).toEqual(["19:a@thread.v2"])
    hub.onMessage(a, JSON.stringify({ type: "focus", convId: null }))
    expect(hub.getFocusedConvIds()).toEqual(["19:a@thread.v2"]) // b still focused
  })

  test("onMessage ignores non-focus / garbage", () => {
    const hub = new HubState(db)
    const s = fakeSocket()
    hub.add(s)
    expect(hub.onMessage(s, "not json")).toBe(false)
    expect(hub.onMessage(s, JSON.stringify({ type: "other" }))).toBe(false)
    expect(hub.getFocusedConvIds()).toEqual([])
  })

  test("broadcast fans to all live clients", () => {
    const hub = new HubState(db)
    const a = fakeSocket()
    const b = fakeSocket()
    hub.add(a)
    hub.add(b)
    a.sent.length = 0
    b.sent.length = 0
    const msg: ChatWsServerMessage = {
      type: "messages-upsert",
      service: "teams",
      convId: "19:a@thread.v2",
      messages: [],
    }
    hub.broadcast(msg)
    expect(a.sent).toEqual([JSON.stringify(msg)])
    expect(b.sent).toEqual([JSON.stringify(msg)])
  })

  test("broadcast skips an over-buffered client", () => {
    const hub = new HubState(db)
    const slow = fakeSocket({ bufferedAmount: 8 * 1024 * 1024 })
    hub.add(slow)
    slow.sent.length = 0
    hub.broadcast({ type: "health", service: "teams", ok: true })
    expect(slow.sent).toHaveLength(0)
  })

  test("reap terminates + evicts a client past the deadline", () => {
    const hub = new HubState(db)
    const s = fakeSocket()
    hub.add(s, 0) // lastSeenAt = 0
    const dead = hub.reap(999_999)
    expect(dead).toContain(s)
    expect(hub.clients.has(s)).toBe(false)
    expect(s.killed).toBe(1)
  })
})

// End-to-end over a real http server + ws client — proves attachWsHub wiring + the module singleton
// `broadcast`/`getFocusedConvIds` that WS-D imports.
describe("attachWsHub (live socket)", () => {
  const server = createServer()
  let url = ""

  afterAll(() => new Promise<void>((r) => server.close(() => r())))

  test("connect gets a snapshot; focus is tracked; broadcast reaches the client", async () => {
    const db = migrate(new Database(":memory:"))
    upsertConversations(db, "teams", [
      { id: "19:live@thread.v2", kind: "group", lastMessageVersion: 1, lastMessageTs: 100 },
    ])
    attachWsHub(server, db)
    await new Promise<void>((r) => server.listen(0, r))
    url = `ws://localhost:${(server.address() as AddressInfo).port}/api/chat/ws`

    const ws = new WebSocket(url)
    const frames: ChatWsServerMessage[] = []
    await new Promise<void>((resolve, reject) => {
      ws.on("message", (m) => {
        frames.push(JSON.parse(m.toString()))
        resolve()
      })
      ws.on("error", reject)
    })
    // snapshot
    expect(frames[0].type).toBe("conversation-upsert")

    // focus round-trips to the sweep-facing accessor
    ws.send(JSON.stringify({ type: "focus", convId: "19:live@thread.v2" }))
    await new Promise((r) => setTimeout(r, 50))
    expect(getFocusedConvIds()).toContain("19:live@thread.v2")

    // a module-level broadcast reaches the live client
    const delta: ChatWsServerMessage = {
      type: "messages-upsert",
      service: "teams",
      convId: "19:live@thread.v2",
      messages: [],
    }
    const got = new Promise<Extract<ChatWsServerMessage, { type: "messages-upsert" }>>(
      (resolve) => {
        ws.on("message", (m) => {
          const f = JSON.parse(m.toString()) as ChatWsServerMessage
          if (f.type === "messages-upsert") resolve(f)
        })
      },
    )
    broadcast(delta)
    expect((await got).convId).toBe("19:live@thread.v2")
    ws.close()
  })
})
