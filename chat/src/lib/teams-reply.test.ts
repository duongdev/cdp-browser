import { describe, expect, it } from "vitest"
import type { TeamsConversation } from "./teams-client"
import { reduceSend, selectReplyTarget } from "./teams-reply"

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

describe("reduceSend — honest failure, draft retained", () => {
  it("idle → sending → sent clears the draft", () => {
    let s = reduceSend({ phase: "idle", draft: "on it" }, { type: "send" })
    expect(s).toEqual({ phase: "sending", draft: "on it" })
    s = reduceSend(s, { type: "ok" })
    expect(s).toEqual({ phase: "idle", draft: "" })
  })

  it("failure keeps the draft and the error code", () => {
    let s = reduceSend({ phase: "idle", draft: "on it" }, { type: "send" })
    s = reduceSend(s, { type: "fail", code: "invalid_auth" })
    expect(s).toEqual({ phase: "failed", draft: "on it", code: "invalid_auth" })
  })

  it("editing after a failure returns to idle with the new draft", () => {
    const s = reduceSend(
      { phase: "failed", draft: "on it", code: "rate_limited" },
      { type: "edit", draft: "on it!" },
    )
    expect(s).toEqual({ phase: "idle", draft: "on it!" })
  })

  it("send is a no-op on an empty draft and while already sending", () => {
    expect(reduceSend({ phase: "idle", draft: "  " }, { type: "send" }).phase).toBe("idle")
    const sending = { phase: "sending" as const, draft: "x" }
    expect(reduceSend(sending, { type: "send" })).toBe(sending)
  })
})
