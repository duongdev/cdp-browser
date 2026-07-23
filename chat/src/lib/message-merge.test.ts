import { describe, expect, it } from "vitest"
import { applyPendingReactions, applyReaction, mergeMessages } from "./message-merge"
import type { TeamsMessage } from "./teams-client"

type Pending = Map<string, Map<string, { emoji: string; desiredMine: boolean }>>
const pending = (
  entries: [string, [string, { emoji: string; desiredMine: boolean }][]][],
): Pending => new Map(entries.map(([id, keys]) => [id, new Map(keys)]))

const msg = (over: Partial<TeamsMessage> & { id: string; ts: number }): TeamsMessage => ({
  senderId: "u1",
  senderName: "Alice",
  body: "hi",
  self: false,
  edited: false,
  deleted: false,
  ...over,
})

describe("mergeMessages", () => {
  it("appends a new message in ts order", () => {
    const existing = [msg({ id: "1", ts: 100 }), msg({ id: "3", ts: 300 })]
    const { messages, changed } = mergeMessages(existing, [msg({ id: "2", ts: 200 })])
    expect(changed).toBe(true)
    expect(messages.map((m) => m.id)).toEqual(["1", "2", "3"])
  })

  it("collapses the optimistic-send echo to one bubble (id collision → incoming wins)", () => {
    const existing = [msg({ id: "100", ts: 100, self: true, body: "hi", senderName: "You" })]
    const incoming = [msg({ id: "100", ts: 100, self: true, body: "hi", senderName: "You" })]
    const { messages, changed } = mergeMessages(existing, incoming)
    expect(messages).toHaveLength(1)
    // Identity-relevant fields unchanged → same ref, no re-render.
    expect(changed).toBe(false)
    expect(messages).toBe(existing)
  })

  it("reconciles an edit (same id, body changed, edited:true → incoming replaces)", () => {
    const existing = [msg({ id: "5", ts: 500, body: "typo", edited: false })]
    const incoming = [msg({ id: "5", ts: 500, body: "fixed", edited: true })]
    const { messages, changed } = mergeMessages(existing, incoming)
    expect(changed).toBe(true)
    expect(messages).toHaveLength(1)
    expect(messages[0].body).toBe("fixed")
    expect(messages[0].edited).toBe(true)
  })

  it("reconciles a delete (incoming deleted:true replaces)", () => {
    const existing = [msg({ id: "5", ts: 500, body: "oops", deleted: false })]
    const incoming = [msg({ id: "5", ts: 500, body: "", deleted: true })]
    const { messages, changed } = mergeMessages(existing, incoming)
    expect(changed).toBe(true)
    expect(messages[0].deleted).toBe(true)
  })

  it("is a no-op on empty incoming (same ref, changed:false)", () => {
    const existing = [msg({ id: "1", ts: 100 })]
    const result = mergeMessages(existing, [])
    expect(result.changed).toBe(false)
    expect(result.messages).toBe(existing)
  })

  it("sorts out-of-order incoming oldest-first", () => {
    const { messages, changed } = mergeMessages(
      [],
      [msg({ id: "2", ts: 200 }), msg({ id: "1", ts: 100 })],
    )
    expect(changed).toBe(true)
    expect(messages.map((m) => m.id)).toEqual(["1", "2"])
  })

  it("breaks a ts tie by id for stable order", () => {
    const { messages } = mergeMessages([], [msg({ id: "b", ts: 100 }), msg({ id: "a", ts: 100 })])
    expect(messages.map((m) => m.id)).toEqual(["a", "b"])
  })

  it("detects a reaction change on an otherwise-identical message", () => {
    const existing = [msg({ id: "1", ts: 100 })]
    const incoming = [
      msg({ id: "1", ts: 100, reactions: [{ key: "like", emoji: "👍", count: 1, mine: false }] }),
    ]
    const { messages, changed } = mergeMessages(existing, incoming)
    expect(changed).toBe(true)
    expect(messages[0].reactions).toHaveLength(1)
  })

  it("stays a same-ref no-op when reactions are unchanged (order-independent)", () => {
    const existing = [
      msg({
        id: "1",
        ts: 100,
        reactions: [
          { key: "like", emoji: "👍", count: 2, mine: true },
          { key: "heart", emoji: "❤️", count: 1, mine: false },
        ],
      }),
    ]
    const incoming = [
      msg({
        id: "1",
        ts: 100,
        reactions: [
          { key: "heart", emoji: "❤️", count: 1, mine: false },
          { key: "like", emoji: "👍", count: 2, mine: true },
        ],
      }),
    ]
    const { messages, changed } = mergeMessages(existing, incoming)
    expect(changed).toBe(false)
    expect(messages).toBe(existing)
  })
})

describe("applyReaction (optimistic toggle)", () => {
  it("adds a brand-new reaction as mine", () => {
    expect(applyReaction(undefined, "like", "👍", false)).toEqual([
      { key: "like", emoji: "👍", count: 1, mine: true },
    ])
  })

  it("joins an existing reaction I had not made", () => {
    const r = [{ key: "like", emoji: "👍", count: 1, mine: false }]
    expect(applyReaction(r, "like", "👍", false)).toEqual([
      { key: "like", emoji: "👍", count: 2, mine: true },
    ])
  })

  it("removes my reaction and drops the key when I was the only reactor", () => {
    const r = [{ key: "like", emoji: "👍", count: 1, mine: true }]
    expect(applyReaction(r, "like", "👍", true)).toEqual([])
  })

  it("removes my reaction but keeps the key when others remain", () => {
    const r = [{ key: "like", emoji: "👍", count: 2, mine: true }]
    expect(applyReaction(r, "like", "👍", true)).toEqual([
      { key: "like", emoji: "👍", count: 1, mine: false },
    ])
  })

  it("is a no-op re-adding a reaction I already made", () => {
    const r = [{ key: "like", emoji: "👍", count: 2, mine: true }]
    expect(applyReaction(r, "like", "👍", false)).toEqual(r)
  })
})

describe("applyPendingReactions (overlay that survives a stale poll)", () => {
  it("adds a desired-mine reaction the server list lacks (optimistic add)", () => {
    const messages = [msg({ id: "1", ts: 100 })]
    const out = applyPendingReactions(
      messages,
      pending([["1", [["like", { emoji: "👍", desiredMine: true }]]]]),
    )
    expect(out).not.toBe(messages)
    expect(out[0].reactions).toEqual([{ key: "like", emoji: "👍", count: 1, mine: true }])
  })

  it("marks mine + bumps count when the server shows the key but not-mine", () => {
    const messages = [
      msg({ id: "1", ts: 100, reactions: [{ key: "like", emoji: "👍", count: 1, mine: false }] }),
    ]
    const out = applyPendingReactions(
      messages,
      pending([["1", [["like", { emoji: "👍", desiredMine: true }]]]]),
    )
    expect(out[0].reactions).toEqual([{ key: "like", emoji: "👍", count: 2, mine: true }])
  })

  it("unmarks + drops the chip when not desired but the server still shows it mine", () => {
    const messages = [
      msg({ id: "1", ts: 100, reactions: [{ key: "like", emoji: "👍", count: 1, mine: true }] }),
    ]
    const out = applyPendingReactions(
      messages,
      pending([["1", [["like", { emoji: "👍", desiredMine: false }]]]]),
    )
    expect(out[0].reactions).toEqual([])
  })

  it("unmarks + decrements but keeps the chip when others remain", () => {
    const messages = [
      msg({ id: "1", ts: 100, reactions: [{ key: "like", emoji: "👍", count: 2, mine: true }] }),
    ]
    const out = applyPendingReactions(
      messages,
      pending([["1", [["like", { emoji: "👍", desiredMine: false }]]]]),
    )
    expect(out[0].reactions).toEqual([{ key: "like", emoji: "👍", count: 1, mine: false }])
  })

  it("leaves other messages and other keys untouched", () => {
    const messages = [
      msg({ id: "1", ts: 100, reactions: [{ key: "heart", emoji: "❤️", count: 1, mine: false }] }),
      msg({ id: "2", ts: 200 }),
    ]
    const out = applyPendingReactions(
      messages,
      pending([["1", [["like", { emoji: "👍", desiredMine: true }]]]]),
    )
    // message 2 untouched (same object ref), message 1's heart preserved alongside the new like.
    expect(out[1]).toBe(messages[1])
    expect(out[0].reactions).toEqual([
      { key: "heart", emoji: "❤️", count: 1, mine: false },
      { key: "like", emoji: "👍", count: 1, mine: true },
    ])
  })

  it("is a same-ref no-op when the server already matches every pending entry", () => {
    const messages = [
      msg({ id: "1", ts: 100, reactions: [{ key: "like", emoji: "👍", count: 1, mine: true }] }),
    ]
    const out = applyPendingReactions(
      messages,
      pending([["1", [["like", { emoji: "👍", desiredMine: true }]]]]),
    )
    expect(out).toBe(messages)
  })

  it("is a same-ref no-op when there are no pending entries", () => {
    const messages = [msg({ id: "1", ts: 100 })]
    expect(applyPendingReactions(messages, pending([]))).toBe(messages)
  })
})
