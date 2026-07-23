import { describe, expect, it } from "vitest"
import type { TeamsConversation } from "./teams-client"
import { selectReplyTarget } from "./teams-reply"

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
