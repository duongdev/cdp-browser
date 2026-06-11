import { describe, expect, it } from "vitest"
import type { ViewEntry } from "./notifications-view"
import { notifIdFromSearch, resolvePushEntry, stripNotifParam } from "./push-route"

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

describe("notifIdFromSearch", () => {
  it("extracts the notif id from a cold-start URL", () => {
    expect(notifIdFromSearch("?notif=slack%3AT1%3AC1%3A9.0")).toBe("slack:T1:C1:9.0")
  })
  it("returns null when absent or empty", () => {
    expect(notifIdFromSearch("")).toBeNull()
    expect(notifIdFromSearch("?perf=1")).toBeNull()
    expect(notifIdFromSearch("?notif=")).toBeNull()
  })
})

describe("stripNotifParam", () => {
  it("removes only the notif param", () => {
    expect(stripNotifParam("?notif=abc&perf=1")).toBe("?perf=1")
    expect(stripNotifParam("?notif=abc")).toBe("")
  })
})

describe("resolvePushEntry", () => {
  it("prefers the store entry (fresher fields) over the payload", () => {
    const store = [e({ id: "n1", channelId: "C1" })]
    const payload = e({ id: "n1" })
    expect(resolvePushEntry("n1", store, payload)?.channelId).toBe("C1")
  })
  it("falls back to the payload when the store no longer has the entry", () => {
    const payload = e({ id: "n2", body: "from push" })
    expect(resolvePushEntry("n2", [], payload)?.body).toBe("from push")
  })
  it("returns null when neither side knows the id (Inbox fallback)", () => {
    expect(resolvePushEntry("gone", [e({ id: "other" })])).toBeNull()
  })
})
