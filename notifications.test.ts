import { describe, expect, it } from "vitest"
// CommonJS module shared with main.js (which can't import src/lib ESM).
import {
  groupKeyFor,
  ingest,
  markAllRead,
  markRead,
  markUnread,
  matchAdapter,
  shouldNotifyOs,
  unreadByTarget,
  unreadCount,
} from "./notifications"

const adapters = [{ name: "teams", match: (h: string) => /(^|\.)teams\.microsoft\.com$/.test(h) }]

describe("matchAdapter", () => {
  it("matches a Teams URL to the teams adapter", () => {
    expect(matchAdapter("https://teams.microsoft.com/v2/", adapters)?.name).toBe("teams")
  })
})

describe("groupKeyFor", () => {
  it("defaults to the targetUrl origin when the payload omits groupKey", () => {
    expect(groupKeyFor({}, "https://teams.microsoft.com/v2/")).toBe("https://teams.microsoft.com")
  })

  it("preserves an explicit groupKey from the capture payload", () => {
    expect(groupKeyFor({ groupKey: "slack:T123" }, "https://app.slack.com/x")).toBe("slack:T123")
  })

  it("returns empty string when neither groupKey nor a parseable origin exists", () => {
    expect(groupKeyFor({}, "not a url")).toBe("")
    expect(groupKeyFor({}, undefined)).toBe("")
  })
})

const payload = (over = {}) => ({ id: "n1", source: "Teams", title: "Hi", body: "there", ...over })

describe("ingest", () => {
  it("prepends a valid payload as an unread entry", () => {
    const { list, entry } = ingest([], payload(), 50)
    expect(entry).toMatchObject({ id: "n1", title: "Hi", read: false })
    expect(list[0]).toBe(entry)
  })

  it("ignores a duplicate id (same toast mirrored across tabs)", () => {
    const first = ingest([], payload(), 50).list
    const { list, entry } = ingest(first, payload({ title: "dup" }), 50)
    expect(entry).toBeNull()
    expect(list).toEqual(first)
  })

  it("rejects a payload with no id", () => {
    const { list, entry } = ingest([], payload({ id: undefined }), 50)
    expect(entry).toBeNull()
    expect(list).toEqual([])
  })

  it("caps the list to the newest N", () => {
    let list: any[] = []
    for (let i = 0; i < 5; i++) list = ingest(list, payload({ id: `n${i}` }), 3).list
    expect(list.map((e) => e.id)).toEqual(["n4", "n3", "n2"])
  })
})

describe("read model", () => {
  const sample = () => [
    { id: "a", targetId: "t1", read: false },
    { id: "b", targetId: "t1", read: true },
    { id: "c", targetId: "t2", read: false },
  ]

  it("counts unread entries", () => {
    expect(unreadCount(sample())).toBe(2)
  })

  it("counts unread per target", () => {
    expect(unreadByTarget(sample())).toEqual({ t1: 1, t2: 1 })
  })

  it("marks one entry read by id without touching others", () => {
    const out = markRead(sample(), "a")
    expect(out.find((n) => n.id === "a")?.read).toBe(true)
    expect(out.find((n) => n.id === "c")?.read).toBe(false)
  })

  it("marks every entry read", () => {
    expect(markAllRead(sample()).every((n) => n.read)).toBe(true)
  })

  it("marks one entry unread by id without touching others", () => {
    const out = markUnread(sample(), "b")
    expect(out.find((n) => n.id === "b")?.read).toBe(false)
    expect(out.find((n) => n.id === "a")?.read).toBe(false)
    expect(out.find((n) => n.id === "c")?.read).toBe(false)
  })
})

describe("shouldNotifyOs", () => {
  const entry = { targetId: "tab-A" }
  it("fires when enabled and the capturing tab is in the background", () => {
    expect(
      shouldNotifyOs(entry, { activeTabId: "tab-B", enabled: true, windowFocused: true }),
    ).toBe(true)
  })
  it("stays silent only when the capturing tab is active AND the app window is focused", () => {
    expect(
      shouldNotifyOs(entry, { activeTabId: "tab-A", enabled: true, windowFocused: true }),
    ).toBe(false)
  })
  it("fires when the capturing tab is active but the app window is not focused", () => {
    // You've alt-tabbed away — you can't see the in-app toast, so the OS toast must fire.
    expect(
      shouldNotifyOs(entry, { activeTabId: "tab-A", enabled: true, windowFocused: false }),
    ).toBe(true)
  })
  it("stays silent when notifications are disabled", () => {
    expect(
      shouldNotifyOs(entry, { activeTabId: "tab-B", enabled: false, windowFocused: false }),
    ).toBe(false)
  })
})
