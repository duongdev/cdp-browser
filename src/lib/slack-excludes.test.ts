import { describe, expect, it } from "vitest"
import {
  addExclude,
  excludedChannelIds,
  excludeTargetFromEntry,
  migrateExcludes,
  removeExclude,
  type SlackExclude,
} from "./slack-excludes"

const base: SlackExclude[] = [
  { team: "T1", channelId: "C1", label: "#general" },
  { team: "T1", channelId: "C2", label: "#random" },
  { team: "T2", channelId: "C1", label: "#ops" },
]

describe("addExclude", () => {
  it("adds a new exclude", () => {
    const out = addExclude(base, { team: "T2", channelId: "C9", label: "#noisy" })
    expect(out).toHaveLength(4)
    expect(out[3]).toEqual({ team: "T2", channelId: "C9", label: "#noisy" })
  })
  it("de-dupes by team+channelId (same ref on no-op)", () => {
    const out = addExclude(base, { team: "T1", channelId: "C1", label: "dupe" })
    expect(out).toBe(base)
  })
  it("treats the same channelId under a different team as distinct", () => {
    const out = addExclude(base, { team: "T9", channelId: "C1", label: "#x" })
    expect(out).toHaveLength(4)
  })
  it("ignores an entry missing team or channelId", () => {
    expect(addExclude(base, { team: "", channelId: "C9", label: "x" })).toBe(base)
    expect(addExclude(base, { team: "T9", channelId: "", label: "x" })).toBe(base)
  })
})

describe("removeExclude", () => {
  it("removes by team+channelId", () => {
    const out = removeExclude(base, "T1", "C1")
    expect(out.map((e) => `${e.team}:${e.channelId}`)).toEqual(["T1:C2", "T2:C1"])
  })
  it("returns the same ref when nothing matched", () => {
    expect(removeExclude(base, "T1", "NOPE")).toBe(base)
  })
})

describe("excludedChannelIds — sweep input", () => {
  it("returns only the channel ids for one workspace", () => {
    expect(excludedChannelIds(base, "T1").sort()).toEqual(["C1", "C2"])
    expect(excludedChannelIds(base, "T2")).toEqual(["C1"])
    expect(excludedChannelIds(base, "T_NONE")).toEqual([])
  })
})

describe("excludeTargetFromEntry", () => {
  it("derives team+channelId from a swept slack entry", () => {
    expect(excludeTargetFromEntry({ groupKey: "slack:T0EXAMPLE02", channelId: "C07" })).toEqual({
      team: "T0EXAMPLE02",
      channelId: "C07",
    })
  })
  it("returns null for non-slack or non-swept entries", () => {
    expect(
      excludeTargetFromEntry({ groupKey: "https://teams.microsoft.com", channelId: "C1" }),
    ).toBeNull()
    expect(excludeTargetFromEntry({ groupKey: "slack:T1" })).toBeNull() // no channelId (hijack)
    expect(excludeTargetFromEntry({})).toBeNull()
  })
})

describe("migrateExcludes — t092 Grid re-key", () => {
  // After the Grid merge, swept entries carry `slack:{groupId}`, so new excludes key by
  // groupId. Existing persisted excludes keyed by a member workspace's teamId must re-key
  // to the org's groupId via the teamId → groupId map, or the mute stops matching.
  const map = { T0EXAMPLE01: "E0EXAMPLE01", E0EXAMPLE01: "E0EXAMPLE01" }

  it("re-keys a member-workspace exclude to its org groupId", () => {
    const list: SlackExclude[] = [{ team: "T0EXAMPLE01", channelId: "C1", label: "#general" }]

    const out = migrateExcludes(list, map)

    expect(out).toEqual([{ team: "E0EXAMPLE01", channelId: "C1", label: "#general" }])
  })

  it("leaves a standalone (no-map-entry) exclude unchanged", () => {
    const list: SlackExclude[] = [{ team: "T0EXAMPLE02", channelId: "C2", label: "#general" }]

    const out = migrateExcludes(list, map)

    expect(out).toBe(list)
  })

  it("returns the same ref when nothing needs re-keying (no-op)", () => {
    // Already keyed by groupId — idempotent.
    const list: SlackExclude[] = [{ team: "E0EXAMPLE01", channelId: "C1", label: "#general" }]

    const out = migrateExcludes(list, map)

    expect(out).toBe(list)
  })

  it("is idempotent on re-run", () => {
    const list: SlackExclude[] = [{ team: "T0EXAMPLE01", channelId: "C1", label: "#general" }]

    const once = migrateExcludes(list, map)
    const twice = migrateExcludes(once, map)

    expect(twice).toBe(once)
    expect(once).toEqual([{ team: "E0EXAMPLE01", channelId: "C1", label: "#general" }])
  })

  it("de-dupes when org and member excludes of the same channel collapse to one key", () => {
    // Both the org pseudo-team and the member workspace had the same channel muted; after
    // re-keying both land on groupId E0 / C1 — keep one.
    const list: SlackExclude[] = [
      { team: "T0EXAMPLE01", channelId: "C1", label: "#general (ws)" },
      { team: "E0EXAMPLE01", channelId: "C1", label: "#general (org)" },
    ]

    const out = migrateExcludes(list, map)

    expect(out).toEqual([{ team: "E0EXAMPLE01", channelId: "C1", label: "#general (ws)" }])
  })

  it("returns the same ref for an empty map", () => {
    const list: SlackExclude[] = [{ team: "T0EXAMPLE01", channelId: "C1", label: "#general" }]

    expect(migrateExcludes(list, {})).toBe(list)
  })
})
