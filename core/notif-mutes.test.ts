import { describe, expect, it } from "vitest"
// CommonJS module shared with web/server.mjs (which can't import src/lib ESM).
import { isMuted, muteKey, unreadExcluding } from "./notif-mutes"

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

  it("does NOT resolve a groupKey without adapter:'slack' (the health-alert payload trap)", () => {
    // A payload carrying a Slack groupKey but no adapter resolves its muteKey to the
    // (undefined) adapter, NOT the groupKey — so it can never be gated by a stored
    // `slack:{groupId}` mute. The Slack capture-health alert push must therefore stamp
    // `adapter: "slack"` (web/server.mjs checkSlackHealthAlerts), or a device that muted
    // that workspace still receives its degrade/restricted push (t093 should-fix).
    expect(muteKey({ groupKey: "slack:E1" })).not.toBe("slack:E1")
  })

  it("resolves a fully-stamped health-alert payload to its workspace key", () => {
    // After the fix: the alert payload carries adapter:'slack' + groupKey, so its muteKey
    // equals the per-workspace key a muting device stores, and the push gate skips it.
    expect(muteKey({ adapter: "slack", groupKey: "slack:E1" })).toBe("slack:E1")
    expect(isMuted(["slack:E1"], { adapter: "slack", groupKey: "slack:E1" })).toBe(true)
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
