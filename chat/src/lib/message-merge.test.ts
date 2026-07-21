import { describe, expect, it } from "vitest"
import { mergeMessages } from "./message-merge"
import type { TeamsMessage } from "./teams-client"

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
})
