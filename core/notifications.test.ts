import { describe, expect, it } from "vitest"
// CommonJS module shared with main.js (which can't import src/lib ESM).
import {
  groupKeyFor,
  ingest,
  markAllRead,
  markRead,
  markUnread,
  matchAdapter,
  parseSlackContext,
  shouldNotifyOs,
  slackGroupKey,
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

describe("parseSlackContext", () => {
  it("extracts teamId and channelId from the unified client URL", () => {
    expect(parseSlackContext("https://app.slack.com/client/T0EXAMPLE03/C0EXAMPLE03")).toEqual({
      teamId: "T0EXAMPLE03",
      channelId: "C0EXAMPLE03",
    })
  })

  it("parses an Enterprise Grid (E-prefixed) team id", () => {
    expect(parseSlackContext("https://app.slack.com/client/E0EXAMPLE01/C0EXAMPLE01")).toEqual({
      teamId: "E0EXAMPLE01",
      channelId: "C0EXAMPLE01",
    })
  })

  it("returns teamId with null channel when the URL is the workspace root", () => {
    expect(parseSlackContext("https://app.slack.com/client/T123")).toEqual({
      teamId: "T123",
      channelId: null,
    })
  })

  it("accepts DM (D) and group (G) channel ids", () => {
    expect(parseSlackContext("https://app.slack.com/client/T1/D999").channelId).toBe("D999")
    expect(parseSlackContext("https://app.slack.com/client/T1/G999").channelId).toBe("G999")
  })

  it("falls back to the subdomain as teamId for legacy workspace URLs", () => {
    expect(parseSlackContext("https://acme.slack.com/messages")).toEqual({
      teamId: "acme",
      channelId: null,
    })
  })

  it("returns nulls for non-Slack and unparseable URLs", () => {
    expect(parseSlackContext("https://teams.microsoft.com/v2/")).toEqual({
      teamId: null,
      channelId: null,
    })
    expect(parseSlackContext("https://slack.com.evil.com/client/T1")).toEqual({
      teamId: null,
      channelId: null,
    })
    expect(parseSlackContext("not a url")).toEqual({ teamId: null, channelId: null })
  })
})

describe("slackGroupKey", () => {
  it("buckets by team id so workspaces sharing app.slack.com stay distinct", () => {
    expect(slackGroupKey("https://app.slack.com/client/T111/C1")).toBe("slack:T111")
    expect(slackGroupKey("https://app.slack.com/client/T222/C1")).toBe("slack:T222")
  })

  it("returns empty string when no team id is resolvable", () => {
    expect(slackGroupKey("https://app.slack.com/")).toBe("")
    expect(slackGroupKey("not a url")).toBe("")
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

  it("with a raised cap, cross-adapter entries survive (Slack does not evict Teams/Outlook)", () => {
    // Scenario: 40 Slack entries ingested, then 15 Teams entries.
    // With cap=50 (old): Teams entries would evict the oldest 5 Slack entries (no cross-adapter protection).
    // With cap=200 (new): all 55 entries survive.
    let list: any[] = []
    // Ingest 40 Slack entries.
    for (let i = 0; i < 40; i++)
      list = ingest(list, payload({ id: `slack:${i}`, source: "Slack" }), 200).list
    expect(list.length).toBe(40)
    // Ingest 15 Teams entries.
    for (let i = 0; i < 15; i++)
      list = ingest(list, payload({ id: `teams:${i}`, source: "Teams" }), 200).list
    // With cap=200, all 55 entries survive. All Teams entries present.
    expect(list.length).toBe(55)
    const teamIds = list.filter((n) => n.source === "Teams").map((n) => n.id)
    expect(teamIds.length).toBe(15)
    expect(teamIds[0]).toBe("teams:14") // Newest Team entry is prepended.
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

  // t101 — per-source mutes gate the OS notification (Electron parity with the PWA).
  it("stays silent when the entry's source is muted", () => {
    const teams = { targetId: "tab-A", adapter: "teams" }
    expect(
      shouldNotifyOs(teams, {
        activeTabId: "tab-B",
        enabled: true,
        windowFocused: true,
        mutes: ["teams"],
      }),
    ).toBe(false)
  })
  it("mutes a Slack workspace by its groupKey while another workspace stays loud", () => {
    const muted = { targetId: "tab-A", adapter: "slack", groupKey: "slack:T1" }
    const loud = { targetId: "tab-A", adapter: "slack", groupKey: "slack:T2" }
    const opts = { activeTabId: "tab-B", enabled: true, windowFocused: true, mutes: ["slack:T1"] }
    expect(shouldNotifyOs(muted, opts)).toBe(false)
    expect(shouldNotifyOs(loud, opts)).toBe(true)
  })
  it("mutes nothing when mutes is empty or omitted (opt-out default)", () => {
    const teams = { targetId: "tab-A", adapter: "teams" }
    expect(
      shouldNotifyOs(teams, {
        activeTabId: "tab-B",
        enabled: true,
        windowFocused: true,
        mutes: [],
      }),
    ).toBe(true)
    expect(
      shouldNotifyOs(teams, { activeTabId: "tab-B", enabled: true, windowFocused: true }),
    ).toBe(true)
  })
  it("master off still wins over an unmuted source", () => {
    const teams = { targetId: "tab-A", adapter: "teams" }
    expect(
      shouldNotifyOs(teams, {
        activeTabId: "tab-B",
        enabled: false,
        windowFocused: true,
        mutes: [],
      }),
    ).toBe(false)
  })
})
