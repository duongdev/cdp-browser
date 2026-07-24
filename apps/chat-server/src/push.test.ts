import Database from "better-sqlite3"
import { beforeEach, describe, expect, test, vi } from "vitest"
import type {
  ChatConversation,
  ChatWsServerMessage,
  ConversationsPage,
  HistoryPage,
} from "./contract.ts"
import { stubProvider } from "./providers/stub-provider.ts"
import { buildPushPayload, createPushSender, pushTitle, shouldPush, type WebPush } from "./push.ts"
import * as store from "./store.ts"
import { migrate } from "./store.ts"
import { createSweepEngine } from "./sweep.ts"

const SERVICE = "mock"

function conv(over: Partial<ChatConversation> & Pick<ChatConversation, "id">): ChatConversation {
  return {
    service: SERVICE,
    kind: "group",
    topic: null,
    lastMessageId: null,
    lastMessageVersion: 1,
    lastMessageTs: 1000,
    lastMessagePreview: "hi",
    readTs: 0,
    lastMessageFromMe: false,
    unreadSticky: false,
    muted: false,
    ...over,
  }
}

// ---- pure gate ------------------------------------------------------------

describe("shouldPush gate", () => {
  const c = (o: Partial<ChatConversation> = {}) =>
    conv({ id: "a", lastMessageTs: 1000, readTs: 0, lastMessageFromMe: false, ...o })

  test("cold start (no prior) never pushes", () => {
    expect(shouldPush(c(), false, null, false)).toBe(false)
  })
  test("own send never pushes", () => {
    expect(shouldPush(c({ lastMessageFromMe: true }), true, null, false)).toBe(false)
  })
  test("already-read (ts <= readTs) never pushes", () => {
    expect(shouldPush(c({ lastMessageTs: 500, readTs: 500 }), true, null, false)).toBe(false)
  })
  test("fresh inbound, unmuted, pushes", () => {
    expect(shouldPush(c(), true, null, false)).toBe(true)
  })
  test("muted-forever suppresses", () => {
    expect(shouldPush(c(), true, { muted: true }, false)).toBe(false)
  })
  test("muted but notifyOnMention + mentionsMe pushes through", () => {
    expect(shouldPush(c(), true, { muted: true, notifyOnMention: true }, true)).toBe(true)
  })
  test("muted + notifyOnMention but NOT mentioned stays silent", () => {
    expect(shouldPush(c(), true, { muted: true, notifyOnMention: true }, false)).toBe(false)
  })
  test("an expired timed-mute is treated unmuted", () => {
    expect(shouldPush(c(), true, { muted: true, mutedUntil: 500 }, false, 1000)).toBe(true)
  })
})

describe("pushTitle / buildPushPayload", () => {
  test("group with a topic → '{sender} · {topic}'", () => {
    const t = pushTitle(conv({ id: "a", kind: "group", topic: "Design" }), "Alice")
    expect(t).toBe("Alice · Design")
  })
  test("DM → the resolved conversation title", () => {
    const t = pushTitle(conv({ id: "a", kind: "oneOnOne", title: "Bob" }), "Bob")
    expect(t).toBe("Bob")
  })
  test("payload carries the SW contract fields for deep-routing", () => {
    const p = buildPushPayload(
      conv({
        id: "19:x",
        kind: "oneOnOne",
        title: "Bob",
        lastMessagePreview: "yo",
        lastMessageId: "m5",
        lastMessageTs: 42,
      }),
      "Bob",
    )
    expect(p).toMatchObject({
      type: "teams",
      title: "Bob",
      body: "yo",
      convId: "19:x",
      msgId: "m5",
      ts: 42,
      tag: "19:x",
    })
  })
})

// ---- sender: subscribe/unsubscribe roundtrip + 410-prune ------------------

function fakeWebPush(behavior: (endpoint: string) => Promise<void>): WebPush {
  return {
    sendNotification: async (sub: unknown) => {
      await behavior((sub as { endpoint: string }).endpoint)
      return {}
    },
  }
}

describe("createPushSender", () => {
  let db: ReturnType<typeof migrate>
  beforeEach(() => {
    db = migrate(new Database(":memory:"))
  })

  test("subscribe/unsubscribe store roundtrip", () => {
    store.savePushSub(db, SERVICE, { endpoint: "e1", subscription: { endpoint: "e1" } })
    expect(store.listPushSubs(db, SERVICE).map((s) => s.endpoint)).toEqual(["e1"])
    store.deletePushSub(db, SERVICE, "e1")
    expect(store.listPushSubs(db, SERVICE)).toEqual([])
  })

  test("sends to every stored sub", async () => {
    store.savePushSub(db, SERVICE, { endpoint: "e1", subscription: { endpoint: "e1" } })
    store.savePushSub(db, SERVICE, { endpoint: "e2", subscription: { endpoint: "e2" } })
    const seen: string[] = []
    const sender = createPushSender({
      db,
      service: SERVICE,
      webpush: fakeWebPush(async (e) => {
        seen.push(e)
      }),
    })
    const n = await sender.send(buildPushPayload(conv({ id: "a" }), "A"))
    expect(n).toBe(2)
    expect(seen.sort()).toEqual(["e1", "e2"])
  })

  test("a 410 gone prunes that sub; others survive", async () => {
    store.savePushSub(db, SERVICE, { endpoint: "dead", subscription: { endpoint: "dead" } })
    store.savePushSub(db, SERVICE, { endpoint: "live", subscription: { endpoint: "live" } })
    const sender = createPushSender({
      db,
      service: SERVICE,
      webpush: fakeWebPush(async (e) => {
        if (e === "dead") throw Object.assign(new Error("gone"), { statusCode: 410 })
      }),
    })
    const n = await sender.send(buildPushPayload(conv({ id: "a" }), "A"))
    expect(n).toBe(1)
    expect(store.listPushSubs(db, SERVICE).map((s) => s.endpoint)).toEqual(["live"])
  })

  test("a non-410 send error never throws (sweep-safe)", async () => {
    store.savePushSub(db, SERVICE, { endpoint: "e1", subscription: { endpoint: "e1" } })
    const sender = createPushSender({
      db,
      service: SERVICE,
      webpush: fakeWebPush(async () => {
        throw Object.assign(new Error("boom"), { statusCode: 500 })
      }),
    })
    await expect(sender.send(buildPushPayload(conv({ id: "a" }), "A"))).resolves.toBe(0)
    expect(store.listPushSubs(db, SERVICE).map((s) => s.endpoint)).toEqual(["e1"]) // not pruned
  })
})

// ---- sweep integration: push fires with zero WS clients -------------------

class ListProvider {
  convPage: ConversationsPage = { conversations: [], cursor: null }
  history = new Map<string, HistoryPage>()
  provider = stubProvider({
    service: SERVICE,
    listConversations: async () => this.convPage,
    fetchHistory: async (id: string) => this.history.get(id) ?? { messages: [], cursor: null },
  })
}

describe("sweep list lane fires push", () => {
  test("a new inbound last message pushes (after seeding); self/read/mute honored", async () => {
    const db = migrate(new Database(":memory:"))
    const send = vi.fn(async (_payload: unknown) => 1)
    const pushSender = { send }
    const provider = new ListProvider()
    const engine = createSweepEngine({
      db,
      provider: provider.provider,
      service: SERVICE,
      broadcast: (_m: ChatWsServerMessage) => {},
      getFocusedConvIds: () => [],
      pushSender,
    })

    // Seed pass: conversation first seen → NO push (cold start).
    provider.convPage = {
      conversations: [
        conv({ id: "a", lastMessageVersion: 1, lastMessageId: "m1", lastMessageTs: 1000 }),
      ],
      cursor: null,
    }
    await engine.runListOnce()
    expect(send).not.toHaveBeenCalled()

    // A newer inbound message → PUSH.
    provider.convPage = {
      conversations: [
        conv({
          id: "a",
          lastMessageVersion: 2,
          lastMessageId: "m2",
          lastMessageTs: 2000,
          lastMessagePreview: "ping",
        }),
      ],
      cursor: null,
    }
    await engine.runListOnce()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0]).toMatchObject({ convId: "a", body: "ping" })

    // A self send → NO push.
    send.mockClear()
    provider.convPage = {
      conversations: [
        conv({
          id: "a",
          lastMessageVersion: 3,
          lastMessageId: "m3",
          lastMessageTs: 3000,
          lastMessageFromMe: true,
        }),
      ],
      cursor: null,
    }
    await engine.runListOnce()
    expect(send).not.toHaveBeenCalled()

    // Mute the conversation, new inbound → NO push.
    store.setPrefs(db, SERVICE, "a", { muted: true })
    send.mockClear()
    provider.convPage = {
      conversations: [
        conv({ id: "a", lastMessageVersion: 4, lastMessageId: "m4", lastMessageTs: 4000 }),
      ],
      cursor: null,
    }
    await engine.runListOnce()
    expect(send).not.toHaveBeenCalled()
  })
})
