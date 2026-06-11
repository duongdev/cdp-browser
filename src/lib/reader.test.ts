import { describe, expect, it } from "vitest"
import type { ViewEntry } from "./notifications-view"
import { readerRoute } from "./reader"

const e = (over: Partial<ViewEntry>): ViewEntry => ({
  id: "x",
  source: "s",
  title: "t",
  body: "b",
  targetId: "tab",
  ts: 0,
  read: false,
  ...over,
})

describe("readerRoute", () => {
  it("routes a swept Slack entry to history when the bridge exists", () => {
    const entry = e({ adapter: "slack", groupKey: "slack:T1", channelId: "C9" })
    expect(readerRoute(entry, true)).toEqual({ kind: "history", team: "T1", channel: "C9" })
  })

  it("stubs a Slack entry without a channel id (hijack-era)", () => {
    const entry = e({ adapter: "slack", groupKey: "slack:T1" })
    expect(readerRoute(entry, true)).toEqual({ kind: "stub" })
  })

  it("stubs adapters without a content backend (capability table, not branching)", () => {
    expect(readerRoute(e({ adapter: "teams" }), true)).toEqual({ kind: "stub" })
    expect(readerRoute(e({ adapter: "outlook" }), true)).toEqual({ kind: "stub" })
  })

  it("stubs everything when the history bridge is absent (Electron)", () => {
    const entry = e({ adapter: "slack", groupKey: "slack:T1", channelId: "C9" })
    expect(readerRoute(entry, false)).toEqual({ kind: "stub" })
  })
})
