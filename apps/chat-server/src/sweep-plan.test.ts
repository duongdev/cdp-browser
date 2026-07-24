import { describe, expect, test } from "vitest"
import type { ChatConversation, ChatMessage } from "./contract.ts"
import {
  type PriorConversation,
  type PriorMessage,
  planConversationSweep,
  planMessageSweep,
  reactionSignature,
} from "./sweep-plan.ts"

function conv(over: Partial<ChatConversation> & Pick<ChatConversation, "id">): ChatConversation {
  return {
    service: "mock",
    kind: "group",
    topic: null,
    lastMessageId: null,
    lastMessageVersion: 0,
    lastMessageTs: null,
    lastMessagePreview: "",
    readTs: 0,
    lastMessageFromMe: false,
    unreadSticky: false,
    muted: false,
    ...over,
  }
}

function msg(over: Partial<ChatMessage> & Pick<ChatMessage, "id">): ChatMessage {
  return { service: "mock", ts: 1, body: "", ...over }
}

const prior = (over: Partial<PriorConversation> = {}): PriorConversation => ({
  lastMessageVersion: 0,
  readTs: 0,
  unreadSticky: false,
  ...over,
})

describe("planConversationSweep — version gating", () => {
  test("an older/equal version is skipped", () => {
    const fresh = [conv({ id: "a", lastMessageVersion: 5 })]
    const p = new Map([["a", prior({ lastMessageVersion: 5 })]])
    const { changedConversations } = planConversationSweep(fresh, p)
    expect(changedConversations).toEqual([])
  })

  test("a risen version surfaces", () => {
    const fresh = [conv({ id: "a", lastMessageVersion: 6 })]
    const p = new Map([["a", prior({ lastMessageVersion: 5 })]])
    const { changedConversations } = planConversationSweep(fresh, p)
    expect(changedConversations.map((c) => c.id)).toEqual(["a"])
  })

  test("a brand-new conversation surfaces", () => {
    const fresh = [conv({ id: "new", lastMessageVersion: 1 })]
    const { changedConversations } = planConversationSweep(fresh, new Map())
    expect(changedConversations.map((c) => c.id)).toEqual(["new"])
  })

  test("read-state moves even when the version is unchanged", () => {
    const fresh = [conv({ id: "a", lastMessageVersion: 5, readTs: 200 })]
    const p = new Map([["a", prior({ lastMessageVersion: 5, readTs: 100 })]])
    const { changedConversations, readStateChanges } = planConversationSweep(fresh, p)
    expect(changedConversations).toEqual([])
    expect(readStateChanges).toEqual([{ convId: "a", readTs: 200, unreadSticky: false }])
  })

  test("no-op when nothing changed", () => {
    const fresh = [conv({ id: "a", lastMessageVersion: 5, readTs: 100 })]
    const p = new Map([["a", prior({ lastMessageVersion: 5, readTs: 100 })]])
    const out = planConversationSweep(fresh, p)
    expect(out.changedConversations).toEqual([])
    expect(out.readStateChanges).toEqual([])
  })
})

describe("planMessageSweep — change detection", () => {
  const priorMsg = (over: Partial<PriorMessage> = {}): PriorMessage => ({
    body: "",
    edited: false,
    deleted: false,
    reactionSig: "",
    ...over,
  })

  test("new message surfaces", () => {
    const fresh = [msg({ id: "m2", body: "hi" })]
    const p = new Map([["m1", priorMsg({ body: "a" })]])
    expect(planMessageSweep(fresh, p).map((m) => m.id)).toEqual(["m2"])
  })

  test("an unchanged message is skipped", () => {
    const fresh = [msg({ id: "m1", body: "a" })]
    const p = new Map([["m1", priorMsg({ body: "a" })]])
    expect(planMessageSweep(fresh, p)).toEqual([])
  })

  test("an edit (body change) surfaces", () => {
    const fresh = [msg({ id: "m1", body: "b", edited: true })]
    const p = new Map([["m1", priorMsg({ body: "a" })]])
    expect(planMessageSweep(fresh, p).map((m) => m.id)).toEqual(["m1"])
  })

  test("a delete surfaces", () => {
    const fresh = [msg({ id: "m1", body: "", deleted: true })]
    const p = new Map([["m1", priorMsg({ body: "a" })]])
    expect(planMessageSweep(fresh, p).map((m) => m.id)).toEqual(["m1"])
  })

  test("a reaction change surfaces", () => {
    const fresh = [
      msg({ id: "m1", body: "a", reactions: [{ key: "like", emoji: "👍", count: 1, mine: true }] }),
    ]
    const p = new Map([["m1", priorMsg({ body: "a", reactionSig: "" })]])
    expect(planMessageSweep(fresh, p).map((m) => m.id)).toEqual(["m1"])
  })
})

describe("reactionSignature — order-independent", () => {
  test("same buckets, reordered → same signature", () => {
    const a = reactionSignature({
      reactions: [
        { key: "like", emoji: "👍", count: 2, mine: false },
        { key: "heart", emoji: "❤️", count: 1, mine: true },
      ],
    })
    const b = reactionSignature({
      reactions: [
        { key: "heart", emoji: "❤️", count: 1, mine: true },
        { key: "like", emoji: "👍", count: 2, mine: false },
      ],
    })
    expect(a).toBe(b)
  })
})
