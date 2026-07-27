import Database from "better-sqlite3"
import { beforeEach, describe, expect, test, vi } from "vitest"
import type {
  ChatConversation,
  ChatMessage,
  ChatWsServerMessage,
  ConversationsPage,
  HistoryPage,
} from "./contract.ts"
import { ProviderError } from "./providers/provider.ts"
import { stubProvider } from "./providers/stub-provider.ts"
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
    lastMessagePreview: "",
    readTs: 0,
    lastMessageFromMe: false,
    unreadSticky: false,
    muted: false,
    ...over,
  }
}
function msg(over: Partial<ChatMessage> & Pick<ChatMessage, "id">): ChatMessage {
  return { service: SERVICE, ts: 1000, body: "", ...over }
}

/** A hand-controlled provider: the test sets what the next fetch returns; `failNext` injects a
 *  one-shot error. Built on the shared stub so only the two methods the sweep touches are real. */
class ControllableProvider {
  convPage: ConversationsPage = { conversations: [], cursor: null }
  history = new Map<string, HistoryPage>()
  failNext: ProviderError | null = null
  /** Conversation ids whose history fetch always fails — models a stale/deleted conversation. */
  failHistoryFor = new Set<string>()
  provider = stubProvider({
    service: SERVICE,
    listConversations: async () => {
      this.throwIfArmed()
      return this.convPage
    },
    fetchHistory: async (convId) => {
      if (this.failHistoryFor.has(convId)) throw new ProviderError("not_found", 404)
      this.throwIfArmed()
      return this.history.get(convId) ?? { messages: [], cursor: null }
    },
  })
  private throwIfArmed() {
    if (this.failNext) {
      const e = this.failNext
      this.failNext = null
      throw e
    }
  }
}

function makeEngine(controllable: ControllableProvider, focused: string[] = []) {
  const db = migrate(new Database(":memory:"))
  const sent: ChatWsServerMessage[] = []
  const broadcast = vi.fn((m: ChatWsServerMessage) => {
    sent.push(m)
  })
  const engine = createSweepEngine({
    db,
    provider: controllable.provider,
    service: SERVICE,
    broadcast,
    getFocusedConvIds: () => focused,
  })
  return { db, engine, sent, broadcast }
}

describe("sweep list lane", () => {
  let provider: ControllableProvider
  beforeEach(() => {
    provider = new ControllableProvider()
  })

  test("broadcasts a conversation-upsert on a new (versioned) conversation", async () => {
    provider.convPage = {
      conversations: [conv({ id: "a", lastMessageVersion: 2, lastMessagePreview: "hi" })],
      cursor: null,
    }
    const { engine, sent } = makeEngine(provider)
    await engine.runListOnce()
    const up = sent.find((m) => m.type === "conversation-upsert")
    expect(up).toBeTruthy()
    if (up?.type === "conversation-upsert") expect(up.conversations[0].id).toBe("a")
  })

  // PSN-106: a changed conversation must push its MESSAGES too, not only its row — otherwise a
  // non-focused thread stays stale until the user refetches it by hand.
  test("broadcasts messages-upsert for a changed, non-focused conversation", async () => {
    provider.convPage = {
      conversations: [conv({ id: "a", lastMessageVersion: 2 })],
      cursor: null,
    }
    provider.history.set("a", { messages: [msg({ id: "m1", body: "hello" })], cursor: null })
    const { engine, sent } = makeEngine(provider) // nothing focused
    await engine.runListOnce()
    const up = sent.find((m) => m.type === "messages-upsert")
    expect(up).toBeTruthy()
    if (up?.type === "messages-upsert") {
      expect(up.convId).toBe("a")
      expect(up.messages.map((m) => m.id)).toEqual(["m1"])
    }
  })

  test("skips the message fetch for the focused conversation (its own lane owns it)", async () => {
    provider.convPage = {
      conversations: [conv({ id: "a", lastMessageVersion: 2 })],
      cursor: null,
    }
    provider.history.set("a", { messages: [msg({ id: "m1", body: "hello" })], cursor: null })
    const { engine, sent } = makeEngine(provider, ["a"])
    await engine.runListOnce()
    expect(sent.find((m) => m.type === "messages-upsert")).toBeUndefined()
  })

  test("an unchanged conversation triggers no message fetch", async () => {
    provider.convPage = {
      conversations: [conv({ id: "a", lastMessageVersion: 2 })],
      cursor: null,
    }
    provider.history.set("a", { messages: [msg({ id: "m1", body: "hello" })], cursor: null })
    const { engine, sent } = makeEngine(provider)
    await engine.runListOnce() // seeds
    sent.length = 0
    await engine.runListOnce() // same version → no fetch, no delta
    expect(sent.find((m) => m.type === "messages-upsert")).toBeUndefined()
  })

  test("a re-swept unchanged conversation broadcasts no upsert", async () => {
    provider.convPage = {
      conversations: [conv({ id: "a", lastMessageVersion: 2 })],
      cursor: null,
    }
    const { engine, sent } = makeEngine(provider)
    await engine.runListOnce() // seeds the store
    sent.length = 0
    await engine.runListOnce() // same version → no conversation-upsert
    expect(sent.find((m) => m.type === "conversation-upsert")).toBeUndefined()
  })
})

describe("sweep focus lane", () => {
  test("broadcasts messages-upsert for a focused conversation with new messages", async () => {
    const provider = new ControllableProvider()
    provider.history.set("a", {
      messages: [msg({ id: "m1", ts: 1000, body: "hello" })],
      cursor: null,
    })
    const { engine, sent } = makeEngine(provider, ["a"])
    await engine.runFocusOnce(["a"])
    const up = sent.find((m) => m.type === "messages-upsert")
    expect(up).toBeTruthy()
    if (up?.type === "messages-upsert") {
      expect(up.convId).toBe("a")
      expect(up.messages.map((m) => m.id)).toEqual(["m1"])
    }
  })

  test("a re-swept focused conversation with no new messages broadcasts nothing new", async () => {
    const provider = new ControllableProvider()
    provider.history.set("a", { messages: [msg({ id: "m1", body: "hello" })], cursor: null })
    const { engine, sent } = makeEngine(provider, ["a"])
    await engine.runFocusOnce(["a"])
    sent.length = 0
    await engine.runFocusOnce(["a"])
    expect(sent.find((m) => m.type === "messages-upsert")).toBeUndefined()
  })
})

describe("sweep health", () => {
  test("flips to ok:false on a provider error, recovers on the next clean sweep", async () => {
    const provider = new ControllableProvider()
    provider.convPage = { conversations: [conv({ id: "a", lastMessageVersion: 2 })], cursor: null }
    const { engine, sent } = makeEngine(provider)

    provider.failNext = new ProviderError("invalid_auth", 401)
    await engine.runListOnce()
    const bad = sent.find((m) => m.type === "health")
    expect(bad).toEqual({ type: "health", service: SERVICE, ok: false, code: "invalid_auth" })
    expect(engine.health()).toEqual({ ok: false })

    sent.length = 0
    await engine.runListOnce() // clean
    const good = sent.find((m) => m.type === "health")
    expect(good).toEqual({ type: "health", service: SERVICE, ok: true })
    expect(engine.health()).toEqual({ ok: true })
  })

  // PSN-105 G: one conversation the provider no longer has (a stale focused tab) used to call
  // markUnhealthy on EVERY tick, so every connected client showed a false "Reconnecting…" banner.
  test("a single failing conversation does NOT flip service health", async () => {
    const provider = new ControllableProvider()
    provider.failHistoryFor.add("gone")
    const { engine, sent } = makeEngine(provider, ["gone"])

    await engine.runListOnce() // a clean list lane → healthy
    expect(engine.health()).toEqual({ ok: true })
    sent.length = 0

    await engine.runFocusOnce(["gone"])
    expect(sent.find((m) => m.type === "health")).toBeUndefined()
    expect(engine.health()).toEqual({ ok: true })
  })

  test("a failing conversation is logged as its own focus event carrying the convId", async () => {
    const provider = new ControllableProvider()
    provider.failHistoryFor.add("gone")
    const { engine } = makeEngine(provider, ["gone"])
    await engine.runFocusOnce(["gone"])

    const log = engine.getSyncLog()
    expect(log.events).toEqual([
      { kind: "focus", ts: expect.any(Number), ok: false, code: "not_found", convId: "gone" },
    ])
    expect(log.lastErrorCode).toBe("not_found")
    // The failure is real information, but it isn't a service outage.
    expect(engine.health()).toBeNull()
  })

  test("a healthy conversation still syncs when a sibling in the same pass fails", async () => {
    const provider = new ControllableProvider()
    provider.failHistoryFor.add("gone")
    provider.history.set("a", { messages: [msg({ id: "m1", body: "hi" })], cursor: null })
    const { engine, sent } = makeEngine(provider, ["gone", "a"])
    await engine.runFocusOnce(["gone", "a"])

    const up = sent.find((m) => m.type === "messages-upsert")
    expect(up).toBeTruthy()
    if (up?.type === "messages-upsert") expect(up.convId).toBe("a")
    expect(engine.health()).toEqual({ ok: true })
  })

  // Workstream A routes the changed-conversation delta fan-out through runFocusOnce, so a bad
  // conversation in that fan-out must not take the list lane's health down either.
  test("a bad conversation in the list-lane delta fan-out keeps the service healthy", async () => {
    const provider = new ControllableProvider()
    provider.convPage = {
      conversations: [conv({ id: "gone", lastMessageVersion: 2 })],
      cursor: null,
    }
    provider.failHistoryFor.add("gone")
    const { engine, sent } = makeEngine(provider) // nothing focused → "gone" enters the fan-out
    await engine.runListOnce()

    expect(engine.health()).toEqual({ ok: true })
    expect(sent.filter((m) => m.type === "health")).toEqual([
      { type: "health", service: SERVICE, ok: true },
    ])
    expect(engine.getSyncLog().events.map((e) => e.kind)).toEqual(["list", "focus"])
  })

  test("start/stop drives the lanes on fake timers without throwing", async () => {
    vi.useFakeTimers()
    try {
      const provider = new ControllableProvider()
      provider.convPage = {
        conversations: [conv({ id: "a", lastMessageVersion: 2 })],
        cursor: null,
      }
      const { engine, broadcast } = makeEngine(provider)
      engine.start()
      await vi.advanceTimersByTimeAsync(13_000)
      expect(broadcast).toHaveBeenCalled()
      engine.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
