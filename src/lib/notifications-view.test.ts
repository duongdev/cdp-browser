import { describe, expect, it } from "vitest"
import { groupByConversation } from "./notifications-view"

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
  })

  it("keys on groupKey when present, ignoring conversation id and title", () => {
    const list = [
      e({ id: "a", title: "alpha", groupKey: "slack:T1", targetEntity: { id: "c1" } }),
      e({ id: "b", title: "beta", groupKey: "slack:T1", targetEntity: { id: "c2" } }),
      e({ id: "c", title: "gamma", groupKey: "slack:T2", targetEntity: { id: "c1" } }),
    ]
    const groups = groupByConversation(list)
    expect(groups.map((g) => g.key)).toEqual(["slack:T1", "slack:T2"])
    expect(groups[0].items.map((i) => i.id)).toEqual(["a", "b"])
  })

  it("with groupKey === origin, groups and per-group unread match the pre-change keying", () => {
    // Same input keyed by targetEntity.id (old) vs groupKey set to a stable value (new):
    // two messages in conversation c1, one in c2, mirrored to per-origin groupKeys.
    const list = [
      e({
        id: "m3",
        title: "third",
        ts: 300,
        read: false,
        groupKey: "https://o",
        targetEntity: { id: "c1" },
      }),
      e({
        id: "m2",
        title: "second",
        ts: 200,
        read: true,
        groupKey: "https://o",
        targetEntity: { id: "c1" },
      }),
      e({
        id: "m1",
        title: "first",
        ts: 100,
        read: false,
        groupKey: "https://o",
        targetEntity: { id: "c1" },
      }),
    ]
    const groups = groupByConversation(list)
    expect(groups).toHaveLength(1)
    expect(groups[0].key).toBe("https://o")
    expect(groups[0].unread).toBe(2)
    expect(groups[0].items.map((i) => i.id)).toEqual(["m3", "m2", "m1"])
  })
})
