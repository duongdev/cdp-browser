import { describe, expect, it } from "vitest"
import { mergeConversations } from "./conversation-merge"
import type { TeamsConversation } from "./teams-client"

const conv = (over: Partial<TeamsConversation> & { id: string }): TeamsConversation => ({
  kind: "oneOnOne",
  topic: null,
  lastMessageId: null,
  lastMessageVersion: 0,
  lastMessageTs: null,
  lastMessagePreview: "",
  muted: false,
  ...over,
})

describe("mergeConversations", () => {
  it("updates a matched id and reorders it to the top", () => {
    const existing = [conv({ id: "B", lastMessageTs: 200 }), conv({ id: "A", lastMessageTs: 100 })]
    const merged = mergeConversations(existing, [
      conv({ id: "A", lastMessageTs: 300, lastMessagePreview: "new" }),
    ])
    expect(merged.map((c) => c.id)).toEqual(["A", "B"])
    expect(merged[0].lastMessageTs).toBe(300)
    expect(merged[0].lastMessagePreview).toBe("new")
  })

  it("inserts a brand-new conversation at the right sort position", () => {
    const existing = [conv({ id: "B", lastMessageTs: 200 }), conv({ id: "A", lastMessageTs: 100 })]
    const merged = mergeConversations(existing, [conv({ id: "C", lastMessageTs: 150 })])
    expect(merged.map((c) => c.id)).toEqual(["B", "C", "A"])
  })

  it("keeps an existing conversation absent from the fresh page", () => {
    const existing = [conv({ id: "B", lastMessageTs: 200 }), conv({ id: "A", lastMessageTs: 100 })]
    const merged = mergeConversations(existing, [
      conv({ id: "B", lastMessageTs: 250, lastMessagePreview: "x" }),
    ])
    expect(merged.map((c) => c.id)).toEqual(["B", "A"])
    expect(merged.find((c) => c.id === "A")).toBeDefined()
  })

  it("returns the same reference when nothing changed", () => {
    const existing = [conv({ id: "B", lastMessageTs: 200 }), conv({ id: "A", lastMessageTs: 100 })]
    // Fresh page carries field-identical copies (new object refs) of the same rows.
    const freshPage = [conv({ id: "B", lastMessageTs: 200 }), conv({ id: "A", lastMessageTs: 100 })]
    expect(mergeConversations(existing, freshPage)).toBe(existing)
  })

  it("sorts a null lastMessageTs last", () => {
    const existing = [conv({ id: "B", lastMessageTs: 200 })]
    const merged = mergeConversations(existing, [
      conv({ id: "C", lastMessageTs: null }),
      conv({ id: "D", lastMessageTs: 100 }),
    ])
    expect(merged.map((c) => c.id)).toEqual(["B", "D", "C"])
  })
})
