import { describe, expect, it } from "vitest"
import type { SearchHit } from "./chat-client"
import {
  addRecentSearch,
  applyHydrated,
  highlightSegments,
  loadRecentSearchs,
  MAX_RECENT_SEARCHES,
  serializeRecentSearchs,
} from "./search-view"

describe("highlightSegments", () => {
  it("returns null for a blank term", () => {
    expect(highlightSegments("hello world", "")).toBeNull()
    expect(highlightSegments("hello world", "   ")).toBeNull()
  })

  it("returns null when the term is absent", () => {
    expect(highlightSegments("hello world", "deploy")).toBeNull()
  })

  it("returns null for a blank snippet", () => {
    expect(highlightSegments("", "foo")).toBeNull()
  })

  it("splits around a case-insensitive match", () => {
    expect(highlightSegments("Pushed the deploy", "deploy")).toEqual(["Pushed the ", "deploy"])
  })

  it("handles Vietnamese diacritics intact (case-sensitive slice, case-insensitive search)", () => {
    // The needle "triển khai" matches a different-cased substring; diacritics preserved.
    const segs = highlightSegments("Kế hoạch triển khai hôm nay", "TRIỂN KHAI")
    expect(segs).not.toBeNull()
    expect(segs).toEqual(["Kế hoạch ", "triển khai", " hôm nay"])
  })

  it("returns multiple segments for a term that repeats", () => {
    expect(highlightSegments("deploy then deploy again", "deploy")).toEqual([
      "deploy",
      " then ",
      "deploy",
      " again",
    ])
  })
})

describe("recent searches", () => {
  it("prepends a new query and dedupes", () => {
    expect(addRecentSearch(["deploy", "lunch"], "deploy")).toEqual(["deploy", "lunch"])
    expect(addRecentSearch(["deploy"], "lunch")).toEqual(["lunch", "deploy"])
  })

  it("ignores blank queries", () => {
    expect(addRecentSearch(["deploy"], "  ")).toEqual(["deploy"])
    expect(addRecentSearch([], "")).toEqual([])
  })

  it("caps at MAX_RECENT_SEARCHES, dropping the oldest", () => {
    const seed = ["a", "b", "c", "d", "e"]
    expect(addRecentSearch(seed, "f")).toEqual(["f", "a", "b", "c", "d"])
    expect(addRecentSearch(seed, "f").length).toBe(MAX_RECENT_SEARCHES)
  })

  it("round-trips through serialize/load", () => {
    const list = ["deploy", "from:Alice deploy"]
    const s = serializeRecentSearchs(list)
    expect(loadRecentSearchs(s)).toEqual(list)
  })

  it("load tolerates malformed JSON", () => {
    expect(loadRecentSearchs(null)).toEqual([])
    expect(loadRecentSearchs("not json")).toEqual([])
    expect(loadRecentSearchs("[1,2,3]")).toEqual([])
    expect(loadRecentSearchs('["ok", 42, "good"]')).toEqual(["ok", "good"])
  })

  it("load truncates an over-long stored list", () => {
    const tooLong = serializeRecentSearchs(["a", "b", "c", "d", "e", "f", "g"])
    // serialize caps at write, but be defensive on read too.
    expect(loadRecentSearchs(tooLong).length).toBeLessThanOrEqual(MAX_RECENT_SEARCHES)
  })
})

describe("applyHydrated", () => {
  const rowsOf = (over: Partial<SearchHit>[]): SearchHit[] =>
    over.map((r) => ({
      convId: "c1",
      msgId: "m1",
      ts: 1,
      sender: "Alice",
      convTitle: "Demo",
      snippet: "hi",
      source: "substrate" as const,
      hydrated: false,
      ...r,
    }))

  it("returns the same ref when nothing matches", () => {
    const rows = rowsOf([{ msgId: "m1" }])
    expect(applyHydrated(rows, [{ id: "mX" }], "c1")).toBe(rows)
  })

  it("returns the same ref when rows is empty", () => {
    expect(applyHydrated([], [{ id: "m1" }], "c1")).toEqual([])
  })

  it("returns the same ref when incoming is empty", () => {
    const rows = rowsOf([{ msgId: "m1" }])
    expect(applyHydrated(rows, [], "c1")).toBe(rows)
  })

  it("returns the same ref when the convId doesn't match", () => {
    const rows = rowsOf([{ msgId: "m1" }])
    expect(applyHydrated(rows, [{ id: "m1" }], "other")).toBe(rows)
  })

  it("flips a matching hydrated:false row", () => {
    const rows = rowsOf([{ msgId: "m1" }, { msgId: "m2" }])
    const next = applyHydrated(rows, [{ id: "m1" }, { id: "m9" }], "c1")
    expect(next).not.toBe(rows)
    expect(next[0].hydrated).toBe(true)
    expect(next[1].hydrated).toBe(false)
  })

  it("leaves an already-hydrated row untouched (same ref)", () => {
    const rows = rowsOf([{ msgId: "m1", hydrated: true }])
    expect(applyHydrated(rows, [{ id: "m1" }], "c1")).toBe(rows)
  })

  it("flips multiple rows in one pass", () => {
    const rows = rowsOf([{ msgId: "m1" }, { msgId: "m2" }, { msgId: "m3" }])
    const next = applyHydrated(rows, [{ id: "m1" }, { id: "m3" }], "c1")
    expect(next.map((r) => r.hydrated)).toEqual([true, false, true])
  })
})
