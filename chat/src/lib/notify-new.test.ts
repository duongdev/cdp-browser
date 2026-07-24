import { describe, expect, it } from "vitest"
import { newlyArrived } from "./notify-new"
import type { TeamsConversation } from "./teams-client"

const conv = (o: Partial<TeamsConversation>): TeamsConversation =>
  ({
    id: "A",
    kind: "oneOnOne",
    title: "Alice",
    topic: null,
    lastMessageTs: 100,
    lastMessageFromMe: false,
    lastMessagePreview: "hi",
    readTs: 0,
    unreadSticky: false,
    muted: false,
    ...o,
  }) as TeamsConversation

describe("newlyArrived", () => {
  it("does not notify on first sight (launch flood guard)", () => {
    const { arrived, seen } = newlyArrived(new Map(), [conv({ id: "A", lastMessageTs: 100 })])
    expect(arrived).toEqual([])
    expect(seen.get("A")).toBe(100)
  })

  it("notifies when a known conversation gets a newer incoming message", () => {
    const prev = new Map([["A", 100]])
    const { arrived } = newlyArrived(prev, [conv({ id: "A", lastMessageTs: 200 })])
    expect(arrived.map((c) => c.id)).toEqual(["A"])
  })

  it("skips own messages", () => {
    const prev = new Map([["A", 100]])
    const { arrived } = newlyArrived(prev, [
      conv({ id: "A", lastMessageTs: 200, lastMessageFromMe: true }),
    ])
    expect(arrived).toEqual([])
  })

  it("skips unchanged ts", () => {
    const prev = new Map([["A", 200]])
    const { arrived } = newlyArrived(prev, [conv({ id: "A", lastMessageTs: 200 })])
    expect(arrived).toEqual([])
  })
})
