import { describe, expect, it } from "vitest"
import type { ViewEntry } from "./notifications-view"
import { reduceSend, selectReplyTarget } from "./slack-reply"

const e = (over: Partial<ViewEntry>): ViewEntry => ({
  id: "x",
  source: "s",
  title: "t",
  body: "b",
  targetId: "tab",
  adapter: "slack",
  groupKey: "slack:T1",
  channelId: "C1",
  ts: 0,
  read: false,
  ...over,
})

describe("selectReplyTarget — the swappable policy (ADR-0012 §3)", () => {
  it("DM → plain channel message (nobody threads 1:1 DMs)", () => {
    const t = selectReplyTarget(e({ slackKind: "im", slackTs: "10.0" }))
    expect(t).toEqual({ channel: "C1" })
  })

  it("group DM → plain message (conversationally a DM)", () => {
    const t = selectReplyTarget(e({ slackKind: "mpim", slackTs: "10.0" }))
    expect(t).toEqual({ channel: "C1" })
  })

  it("channel mention → reply in that message's thread", () => {
    const t = selectReplyTarget(e({ slackKind: "channel", slackTs: "10.0" }))
    expect(t).toEqual({ channel: "C1", thread_ts: "10.0" })
  })

  it("thread notification → reply in that thread (the parent, not the reply)", () => {
    const t = selectReplyTarget(e({ slackKind: "channel", slackTs: "12.0", slackThreadTs: "10.0" }))
    expect(t).toEqual({ channel: "C1", thread_ts: "10.0" })
  })

  it("missing slackTs on a channel mention falls back to a plain message", () => {
    const t = selectReplyTarget(e({ slackKind: "channel" }))
    expect(t).toEqual({ channel: "C1" })
  })

  it("returns null without a channel identity", () => {
    expect(selectReplyTarget(e({ channelId: undefined }))).toBeNull()
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
