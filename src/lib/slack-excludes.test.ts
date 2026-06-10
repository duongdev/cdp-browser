import { describe, expect, it } from "vitest"
import {
  addExclude,
  excludedChannelIds,
  excludeTargetFromEntry,
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
    expect(excludeTargetFromEntry({ groupKey: "slack:T01CDUT3CBD", channelId: "C07" })).toEqual({
      team: "T01CDUT3CBD",
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
