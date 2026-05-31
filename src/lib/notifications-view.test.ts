import { describe, expect, it } from "vitest"
import { flattenRows, GROUP_ITEM_CAP, groupByConversation, threadKey } from "./notifications-view"

const e = (over: Record<string, unknown>) => ({
  id: "x",
  source: "Microsoft Teams",
  title: "t",
  body: "",
  targetId: "tab",
  targetEntity: null,
  icon: "teams.ico",
  ts: 0,
  read: false,
  ...over,
})

describe("threadKey", () => {
  it("prefers the explicit deep-open thread id", () => {
    expect(
      threadKey(e({ activate: { type: "thread", id: "19:abc" }, targetEntity: { id: "z" } })),
    ).toBe("t:19:abc")
  })

  it("falls back to the entity id, then the title", () => {
    expect(threadKey(e({ targetEntity: { id: "c1" } }))).toBe("c1")
    expect(threadKey(e({ targetEntity: null, title: "Subject" }))).toBe("Subject")
  })

  it("scopes the thread by groupKey so equal ids in two workspaces never merge", () => {
    expect(threadKey(e({ groupKey: "slack:T1", targetEntity: { id: "c1" } }))).toBe("slack:T1::c1")
    expect(threadKey(e({ groupKey: "slack:T2", targetEntity: { id: "c1" } }))).not.toBe(
      threadKey(e({ groupKey: "slack:T1", targetEntity: { id: "c1" } })),
    )
  })
})

describe("groupByConversation", () => {
  it("groups by conversation id, newest-first within a group, groups by most recent message", () => {
    const list = [
      e({ id: "m3", title: "third", ts: 300, targetEntity: { id: "c1" } }),
      e({ id: "m2", title: "second", ts: 200, targetEntity: { id: "c2" } }),
      e({ id: "m1", title: "first", ts: 100, targetEntity: { id: "c1" } }),
    ]
    const groups = groupByConversation(list)
    expect(groups.map((g) => g.key)).toEqual(["c1", "c2"])
    expect(groups[0].items.map((i) => i.id)).toEqual(["m3", "m1"])
  })

  it("splits same-origin Teams threads into separate groups (the per-origin grouping bug)", () => {
    // All Teams toasts share an origin groupKey but belong to different conversations —
    // they must NOT collapse into one group.
    const list = [
      e({
        id: "a",
        title: "Core Team",
        groupKey: "https://teams",
        targetEntity: { id: "19:core" },
      }),
      e({ id: "b", title: "GenAI", groupKey: "https://teams", targetEntity: { id: "19:genai" } }),
      e({
        id: "c",
        title: "Core Team",
        groupKey: "https://teams",
        targetEntity: { id: "19:core" },
      }),
    ]
    const groups = groupByConversation(list)
    expect(groups).toHaveLength(2)
    expect(groups.map((g) => g.label)).toEqual(["Core Team", "GenAI"])
    expect(groups[0].items.map((i) => i.id)).toEqual(["a", "c"])
  })

  it("groups a legacy entity-only Teams message with a fresh activate one of the same thread", () => {
    // A backlog entry captured before the `activate` field (entity only) must key the same
    // as a fresh one of the same conversation, so they don't split and mark-read agrees.
    const list = [
      e({
        id: "fresh",
        activate: { type: "thread", id: "19:abc" },
        targetEntity: { type: "chats", id: "19:abc" },
      }),
      e({ id: "legacy", activate: null, targetEntity: { type: "chats", id: "19:abc" } }),
    ]
    expect(groupByConversation(list)).toHaveLength(1)
  })

  it("keys Outlook mail by its per-message deep-link so same-subject mail never merges", () => {
    const list = [
      e({
        id: "a",
        title: "Re: Lunch?",
        activate: { type: "spa-link", url: "https://o/mail/id/AAQk1" },
        targetEntity: { deepLink: "https://o/mail/id/AAQk1" },
      }),
      e({
        id: "b",
        title: "Re: Lunch?",
        activate: { type: "spa-link", url: "https://o/mail/id/AAQk2" },
        targetEntity: { deepLink: "https://o/mail/id/AAQk2" },
      }),
    ]
    expect(groupByConversation(list)).toHaveLength(2)
  })

  it("falls back to the title when there is no conversation id", () => {
    const list = [
      e({ id: "a", title: "Hello", targetEntity: null }),
      e({ id: "b", title: "Hello", targetEntity: null }),
    ]
    expect(groupByConversation(list)).toHaveLength(1)
  })

  it("labels the group with the latest title, carries the icon, and counts unread", () => {
    const list = [
      e({
        id: "a",
        title: "newest",
        ts: 2,
        read: false,
        icon: "teams.ico",
        targetEntity: { id: "c" },
      }),
      e({ id: "b", title: "old", ts: 1, read: true, targetEntity: { id: "c" } }),
    ]
    const g = groupByConversation(list)[0]
    expect(g.label).toBe("newest")
    expect(g.icon).toBe("teams.ico")
    expect(g.unread).toBe(1)
    expect(g.total).toBe(2)
  })

  it("caps shown items at GROUP_ITEM_CAP while total/unread count the whole thread", () => {
    const list = Array.from({ length: 5 }, (_, i) =>
      e({ id: `m${i}`, ts: 100 - i, read: i > 1, targetEntity: { id: "c1" } }),
    )
    const g = groupByConversation(list)[0]
    expect(g.items).toHaveLength(GROUP_ITEM_CAP)
    expect(g.items.map((i) => i.id)).toEqual(["m0", "m1", "m2"])
    expect(g.total).toBe(5)
    expect(g.unread).toBe(2)
  })

  it("keys an explicit thread activate ahead of the entity id", () => {
    const list = [
      e({ id: "a", activate: { type: "thread", id: "19:x" }, targetEntity: { id: "ignored" } }),
      e({ id: "b", activate: { type: "thread", id: "19:x" }, targetEntity: { id: "other" } }),
    ]
    expect(groupByConversation(list)).toHaveLength(1)
  })
})

describe("flattenRows", () => {
  it("flattens groups into one paint-ordered row list (group order, items within)", () => {
    const list = [
      e({ id: "m3", title: "third", ts: 300, targetEntity: { id: "c1" } }),
      e({ id: "m2", title: "second", ts: 200, targetEntity: { id: "c2" } }),
      e({ id: "m1", title: "first", ts: 100, targetEntity: { id: "c1" } }),
    ]
    const groups = groupByConversation(list)
    expect(flattenRows(groups).map((r) => r.id)).toEqual(["m3", "m1", "m2"])
  })

  it("excludes collapsed (capped) items so it matches what is painted", () => {
    const list = Array.from({ length: 5 }, (_, i) =>
      e({ id: `m${i}`, ts: 100 - i, targetEntity: { id: "c1" } }),
    )
    const groups = groupByConversation(list)
    expect(flattenRows(groups).map((r) => r.id)).toEqual(["m0", "m1", "m2"])
  })

  it("returns [] for an empty group list", () => {
    expect(flattenRows([])).toEqual([])
  })
})
