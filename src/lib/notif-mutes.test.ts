import { describe, expect, it } from "vitest"
import { isMuted, muteKey, slackMuteRows, toggleMute, unreadExcluding } from "./notif-mutes"

describe("muteKey", () => {
  it("uses the groupKey for a Slack entry (per merged workspace)", () => {
    expect(muteKey({ adapter: "slack", groupKey: "slack:E0EXAMPLE01" })).toBe("slack:E0EXAMPLE01")
  })

  it("uses the adapter name for Teams/Outlook (per service)", () => {
    expect(muteKey({ adapter: "teams" })).toBe("teams")
    expect(muteKey({ adapter: "outlook" })).toBe("outlook")
  })

  it("falls back to 'slack' when a Slack entry has no groupKey", () => {
    expect(muteKey({ adapter: "slack" })).toBe("slack")
    expect(muteKey({ adapter: "slack", groupKey: "" })).toBe("slack")
  })
})

describe("isMuted", () => {
  it("is true when the entry's muteKey is in the mutes array", () => {
    expect(isMuted(["teams"], { adapter: "teams" })).toBe(true)
    expect(isMuted(["slack:E1"], { adapter: "slack", groupKey: "slack:E1" })).toBe(true)
  })

  it("is false when the key is absent (opt-out default)", () => {
    expect(isMuted([], { adapter: "teams" })).toBe(false)
    expect(isMuted(["outlook"], { adapter: "teams" })).toBe(false)
    expect(isMuted(["slack:E1"], { adapter: "slack", groupKey: "slack:E2" })).toBe(false)
  })

  it("treats undefined mutes as empty (nothing muted)", () => {
    expect(isMuted(undefined, { adapter: "teams" })).toBe(false)
  })

  it("accepts a Set of mutes", () => {
    expect(isMuted(new Set(["teams"]), { adapter: "teams" })).toBe(true)
    expect(isMuted(new Set(["outlook"]), { adapter: "teams" })).toBe(false)
  })
})

describe("toggleMute", () => {
  it("adds an absent key (a fresh muted source)", () => {
    expect(toggleMute([], "teams")).toEqual(["teams"])
    expect(toggleMute(["outlook"], "teams")).toEqual(["outlook", "teams"])
  })

  it("removes a present key (un-mute)", () => {
    expect(toggleMute(["teams"], "teams")).toEqual([])
    expect(toggleMute(["outlook", "teams"], "teams")).toEqual(["outlook"])
  })

  it("returns a new array on a change (never mutates the input)", () => {
    const before = ["teams"]
    const after = toggleMute(before, "outlook")

    expect(after).not.toBe(before)
    expect(before).toEqual(["teams"])
  })
})

describe("unreadExcluding", () => {
  const list = () => [
    { id: "a", adapter: "teams", read: false },
    { id: "b", adapter: "outlook", read: false },
    { id: "c", adapter: "slack", groupKey: "slack:E1", read: false },
    { id: "d", adapter: "slack", groupKey: "slack:E2", read: false },
    { id: "e", adapter: "teams", read: true },
  ]

  it("counts every unread entry when nothing is muted", () => {
    expect(unreadExcluding(list(), [], true)).toBe(4)
  })

  it("excludes unread entries whose muteKey is muted", () => {
    expect(unreadExcluding(list(), ["teams"], true)).toBe(3)
    expect(unreadExcluding(list(), ["teams", "slack:E1"], true)).toBe(2)
  })

  it("never counts read entries (the read 'e' stays out even unmuted)", () => {
    expect(unreadExcluding(list(), [], true)).toBe(4)
  })

  it("returns 0 when the master is off, regardless of mutes", () => {
    expect(unreadExcluding(list(), [], false)).toBe(0)
    expect(unreadExcluding(list(), ["teams"], false)).toBe(0)
  })

  it("gives two devices different counts from the same list", () => {
    const phone = unreadExcluding(list(), ["teams", "slack:E1"], true)
    const desktop = unreadExcluding(list(), [], true)

    expect(phone).toBe(2)
    expect(desktop).toBe(4)
    expect(phone).not.toBe(desktop)
  })

  it("accepts a Set of mutes", () => {
    expect(unreadExcluding(list(), new Set(["teams"]), true)).toBe(3)
  })

  it("defaults undefined mutes to empty", () => {
    expect(unreadExcluding(list(), undefined, true)).toBe(4)
  })
})

describe("slackMuteRows (t101 — Electron per-workspace mute list from captured entries)", () => {
  it("returns one row per distinct Slack workspace, labelled by source", () => {
    const rows = slackMuteRows([
      { adapter: "slack", groupKey: "slack:T1", source: "Acme" },
      { adapter: "slack", groupKey: "slack:T2", source: "Globex" },
    ])
    expect(rows).toEqual([
      { key: "slack:T1", label: "Acme" },
      { key: "slack:T2", label: "Globex" },
    ])
  })

  it("de-dupes multiple entries of the same workspace, first-seen order", () => {
    const rows = slackMuteRows([
      { adapter: "slack", groupKey: "slack:T2", source: "Globex" },
      { adapter: "slack", groupKey: "slack:T1", source: "Acme" },
      { adapter: "slack", groupKey: "slack:T1", source: "Acme" },
    ])
    expect(rows).toEqual([
      { key: "slack:T2", label: "Globex" },
      { key: "slack:T1", label: "Acme" },
    ])
  })

  it("takes the first non-empty source as the label", () => {
    const rows = slackMuteRows([
      { adapter: "slack", groupKey: "slack:T1", source: "" },
      { adapter: "slack", groupKey: "slack:T1", source: "Acme" },
    ])
    expect(rows).toEqual([{ key: "slack:T1", label: "Acme" }])
  })

  it("falls back to the key as label when no source is present", () => {
    const rows = slackMuteRows([{ adapter: "slack", groupKey: "slack:T9" }])
    expect(rows).toEqual([{ key: "slack:T9", label: "slack:T9" }])
  })

  it("ignores non-Slack entries and returns [] for an empty list", () => {
    expect(slackMuteRows([{ adapter: "teams" }, { adapter: "outlook" }])).toEqual([])
    expect(slackMuteRows([])).toEqual([])
  })
})
