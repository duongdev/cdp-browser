import { describe, expect, it } from "vitest"
import type { TeamsConversation } from "./teams-client"
import { partialSendMessage, selectReplyTarget } from "./teams-reply"

const conv = (over: Partial<TeamsConversation> = {}): TeamsConversation => ({
  id: "19:abc@unq.gbl.spaces",
  kind: "oneOnOne",
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
})

describe("selectReplyTarget — flat Teams chats (single owner of where a reply lands)", () => {
  it("returns the conversation id (Teams chats are flat — no thread)", () => {
    expect(selectReplyTarget(conv({ id: "19:xyz@thread.v2" }))).toEqual({
      convId: "19:xyz@thread.v2",
    })
  })

  it("returns null without a conversation id", () => {
    expect(selectReplyTarget(conv({ id: "" }))).toBeNull()
  })
})

// PSN-121: a partial attachment send used to be a console.warn, so "only the first image arrived"
// looked identical to a clean send. The copy has to name what was dropped.
describe("partialSendMessage — a partial attachment send must name what was lost", () => {
  it("says nothing when nothing failed", () => {
    expect(partialSendMessage([])).toBe("")
    expect(partialSendMessage(["", "   "])).toBe("")
  })

  it("names a single dropped file, singular", () => {
    expect(partialSendMessage(["b.png"])).toBe(
      "1 attachment failed to send: b.png. The rest were sent.",
    )
  })

  it("names every file up to the cap, plural", () => {
    expect(partialSendMessage(["a.png", "b.png", "c.png"])).toBe(
      "3 attachments failed to send: a.png, b.png, c.png. The rest were sent.",
    )
  })

  it("summarises past the cap but keeps the real total", () => {
    expect(partialSendMessage(["a.png", "b.png", "c.png", "d.png", "e.png"])).toBe(
      "5 attachments failed to send: a.png, b.png, c.png and 2 more. The rest were sent.",
    )
  })

  it("ignores blank names when counting", () => {
    expect(partialSendMessage(["a.png", "", "b.png"])).toBe(
      "2 attachments failed to send: a.png, b.png. The rest were sent.",
    )
  })
})
