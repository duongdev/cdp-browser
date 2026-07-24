import { describe, expect, it } from "vitest"
import { type CatalogEntry, filterEmoji, groupByCategory } from "./emoji-catalog"

const ENTRIES: CatalogEntry[] = [
  { i: "like", u: "👍", d: "thumbs up", k: "good approve", c: 0 },
  { i: "heart", u: "❤️", d: "red heart", k: "love", c: 0 },
  { i: "1f4af_hundredpointssymbol", u: "💯", d: "hundred points", k: "perfect score", c: 1 },
  { i: "1f440_eyes", u: "👀", d: "eyes", k: "look see", c: 1 },
  { i: "fire", u: "🔥", d: "fire", k: "hot flame", c: 2 },
]

describe("filterEmoji", () => {
  it("matches on d (description)", () => {
    expect(filterEmoji(ENTRIES, "heart").map((e) => e.i)).toEqual(["heart"])
  })

  it("matches on k (keywords)", () => {
    expect(filterEmoji(ENTRIES, "flame").map((e) => e.i)).toEqual(["fire"])
  })

  it("matches on i (id)", () => {
    expect(filterEmoji(ENTRIES, "1f440").map((e) => e.i)).toEqual(["1f440_eyes"])
  })

  it("is case-insensitive", () => {
    expect(filterEmoji(ENTRIES, "HEART").map((e) => e.i)).toEqual(["heart"])
  })

  it("empty query returns all entries", () => {
    expect(filterEmoji(ENTRIES, "")).toHaveLength(ENTRIES.length)
  })

  it("no match returns empty array", () => {
    expect(filterEmoji(ENTRIES, "zzznomatch")).toHaveLength(0)
  })
})

describe("groupByCategory", () => {
  it("groups entries by c index", () => {
    const groups = groupByCategory(ENTRIES)
    expect(groups.get(0)?.map((e) => e.i)).toEqual(["like", "heart"])
    expect(groups.get(1)?.map((e) => e.i)).toEqual(["1f4af_hundredpointssymbol", "1f440_eyes"])
    expect(groups.get(2)?.map((e) => e.i)).toEqual(["fire"])
  })

  it("preserves insertion order within each group", () => {
    const ordered: CatalogEntry[] = [
      { i: "a", u: "A", d: "alpha", k: "", c: 0 },
      { i: "b", u: "B", d: "beta", k: "", c: 0 },
      { i: "c", u: "C", d: "gamma", k: "", c: 0 },
    ]
    const groups = groupByCategory(ordered)
    expect(groups.get(0)?.map((e) => e.i)).toEqual(["a", "b", "c"])
  })
})
