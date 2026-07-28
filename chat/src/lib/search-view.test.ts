import { describe, expect, it } from "vitest"
import type { ParsedQuery, SearchHit } from "./chat-client"
import {
  addRecentSearch,
  applyHydrated,
  DEFAULT_SCOPE_KIND,
  DEFAULT_SORT,
  filterChips,
  formatDateChip,
  hasFilters,
  highlightSegments,
  loadRecentSearchs,
  MAX_RECENT_SEARCHES,
  parseSort,
  removeRecentSearch,
  SCOPE_KINDS,
  SEARCH_SORT_KEY,
  SORTS,
  serializeRecentSearchs,
  stripOperator,
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

  it("splits so the plain segment always lands at an even index, matched at odd", () => {
    const segs = highlightSegments("Pushed the deploy", "deploy")
    expect(segs).not.toBeNull()
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    segs!.forEach((seg, i) => {
      if (i % 2 === 1) expect(seg.toLowerCase()).toBe("deploy")
    })
  })

  it("handles Vietnamese diacritics intact (case-sensitive slice, case-insensitive search)", () => {
    // The needle "triển khai" matches a different-cased substring; diacritics preserved.
    const segs = highlightSegments("Kế hoạch triển khai hôm nay", "TRIỂN KHAI")
    expect(segs).not.toBeNull()
    expect(segs).toEqual(["Kế hoạch ", "triển khai", " hôm nay"])
  })

  it("returns multiple segments for a term that repeats, plain always at even index", () => {
    // Regression: a leading empty plain segment keeps even=plain/odd=match parity so the caller's
    // `i % 2 === 1` check highlights the right half. The bug shipped this as
    // ["deploy", " then ", "deploy", " again"] — even index 0 held a MATCH, so the renderer (which
    // always treats even as plain) drew the leading "deploy" unhighlighted and lit up " then "
    // instead.
    expect(highlightSegments("deploy then deploy again", "deploy")).toEqual([
      "",
      "deploy",
      " then ",
      "deploy",
      " again",
    ])
  })

  it("highlights a match at the very start of the snippet (bug repro: 'hello ...')", () => {
    // Live bug (PSN-115): every message starts with the searched word ("hello"), so the match sits
    // at index 0 on every row — the exact case the old parity-by-position logic got backwards.
    expect(highlightSegments("hello world, welcome", "hello")).toEqual([
      "",
      "hello",
      " world, welcome",
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

  it("removeRecentSearch drops an exact match, leaves the rest in order", () => {
    expect(removeRecentSearch(["deploy", "lunch", "hi"], "lunch")).toEqual(["deploy", "hi"])
  })

  it("removeRecentSearch is a no-op when the query isn't in the list", () => {
    expect(removeRecentSearch(["deploy", "lunch"], "nope")).toEqual(["deploy", "lunch"])
  })

  it("removeRecentSearch on an empty list stays empty", () => {
    expect(removeRecentSearch([], "deploy")).toEqual([])
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
      convKind: "group" as const,
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

// ---- WS-F: filter chips, sort, scope --------------------------------------

const parsedOf = (over: Partial<ParsedQuery["filters"]>): ParsedQuery => ({
  text: "",
  filters: over,
})

describe("stripOperator", () => {
  it("removes a bare-value token and leaves the rest", () => {
    expect(stripOperator("from:Ann deploy now", "from", "Ann")).toBe("deploy now")
  })

  it("removes a quoted-value token", () => {
    expect(stripOperator('from:"Ann Wong" deploy', "from", "Ann Wong")).toBe("deploy")
  })

  it("is case-insensitive on the operator", () => {
    expect(stripOperator("FROM:Ann deploy", "from", "Ann")).toBe("deploy")
  })

  it("preserves other operators + free text", () => {
    expect(stripOperator("from:Ann has:link deploy in:dev", "from", "Ann")).toBe(
      "has:link deploy in:dev",
    )
  })

  it("returns the query unchanged when the value isn't present", () => {
    expect(stripOperator("from:Bob deploy", "from", "Ann")).toBe("from:Bob deploy")
  })

  it("ignores empty op or value", () => {
    expect(stripOperator("from:Ann", "", "Ann")).toBe("from:Ann")
    expect(stripOperator("from:Ann", "from", "")).toBe("from:Ann")
  })

  it("keeps Vietnamese diacritics intact in the value", () => {
    expect(stripOperator("from:Trần deploy", "from", "Trần")).toBe("deploy")
  })

  it("keeps CJK intact in the value", () => {
    expect(stripOperator("in:会議 deploy", "in", "会議")).toBe("deploy")
  })

  it("escapes regex metacharacters in the value", () => {
    expect(stripOperator("from:Ann.B deploy", "from", "Ann.B")).toBe("deploy")
    expect(stripOperator('from:"(test)" deploy', "from", "(test)")).toBe("deploy")
  })
})

describe("formatDateChip", () => {
  it("formats a ts as UTC YYYY-MM-DD", () => {
    expect(formatDateChip(Date.UTC(2026, 6, 1))).toBe("2026-07-01")
  })

  it("formats a bare-year ts as Jan 1", () => {
    expect(formatDateChip(Date.UTC(2024, 0, 1))).toBe("2024-01-01")
  })

  it("returns empty string for non-finite ts", () => {
    expect(formatDateChip(Number.NaN)).toBe("")
  })
})

describe("filterChips", () => {
  it("emits a chip per filter, has: one per entry", () => {
    const chips = filterChips(
      parsedOf({
        from: "Ann",
        in: "dev",
        has: ["link", "file"],
        mentionsMe: true,
      }),
    )
    const labels = chips.map((c) => c.label)
    expect(labels).toEqual(["from: Ann", "in: dev", "has: link", "has: file", "mentions: me"])
  })

  it("keys are stable", () => {
    const chips = filterChips(parsedOf({ from: "Ann", has: ["link"] }))
    expect(chips.map((c) => c.key)).toEqual(["from:Ann", "has:link"])
  })

  it("emits a date chip with a YYYY-MM-DD label", () => {
    const ts = Date.UTC(2026, 6, 1)
    const chips = filterChips(parsedOf({ afterTs: ts }))
    expect(chips).toHaveLength(1)
    expect(chips[0].label).toBe("after: 2026-07-01")
  })

  it("returns no chips when no filters are set", () => {
    expect(filterChips(parsedOf({}))).toEqual([])
  })

  it("chip.removeQuery strips that operator and keeps the rest (from)", () => {
    const chips = filterChips(parsedOf({ from: "Ann" }))
    expect(chips[0].removeQuery('from:Ann "deploy now"')).toBe('"deploy now"')
  })

  it("chip.removeQuery strips a quoted from value", () => {
    const chips = filterChips(parsedOf({ from: "Ann Wong" }))
    expect(chips[0].removeQuery('from:"Ann Wong" deploy')).toBe("deploy")
  })

  it("chip.removeQuery strips only the targeted has: entry", () => {
    const chips = filterChips(parsedOf({ has: ["link", "file"] }))
    expect(chips[0].removeQuery("has:link has:file deploy")).toBe("has:file deploy")
    expect(chips[1].removeQuery("has:link has:file deploy")).toBe("has:link deploy")
  })

  it("date chip.removeQuery strips the user's original token regardless of spelling", () => {
    // The parser keeps only the last `after:` token; the chip label is the normalised date but
    // the user may have typed a bare year. Strip the first `after:<...>` token.
    const ts = Date.UTC(2024, 0, 1)
    const chips = filterChips(parsedOf({ afterTs: ts }))
    expect(chips[0].removeQuery("after:2024 deploy")).toBe("deploy")
    expect(chips[0].removeQuery("after:2024-01-01 deploy")).toBe("deploy")
    expect(chips[0].removeQuery('after:"2024" deploy')).toBe("deploy")
  })

  it("mentions chip strips the mentions:me token", () => {
    const chips = filterChips(parsedOf({ mentionsMe: true }))
    expect(chips[0].removeQuery("mentions:me deploy")).toBe("deploy")
  })
})

describe("hasFilters", () => {
  it("true when any filter is set", () => {
    expect(hasFilters(parsedOf({ from: "x" }))).toBe(true)
    expect(hasFilters(parsedOf({ has: ["link"] }))).toBe(true)
    expect(hasFilters(parsedOf({ mentionsMe: true }))).toBe(true)
  })

  it("false for empty filters", () => {
    expect(hasFilters(parsedOf({}))).toBe(false)
  })

  it("false for null/undefined", () => {
    expect(hasFilters(null)).toBe(false)
    expect(hasFilters(undefined)).toBe(false)
  })
})

describe("sort + scope constants", () => {
  it("SORTS is relevance-then-recent", () => {
    expect(SORTS).toEqual(["relevance", "recent"])
  })

  it("DEFAULT_SORT is relevance", () => {
    expect(DEFAULT_SORT).toBe("relevance")
  })

  it("SCOPE_KINDS is all/dm/group", () => {
    expect(SCOPE_KINDS).toEqual(["all", "dm", "group"])
  })

  it("DEFAULT_SCOPE_KIND is all", () => {
    expect(DEFAULT_SCOPE_KIND).toBe("all")
  })

  it("SEARCH_SORT_KEY is chat-scoped", () => {
    expect(SEARCH_SORT_KEY).toBe("chat:search-sort")
  })

  it("parseSort accepts the two known values, falls back to default otherwise", () => {
    expect(parseSort("recent")).toBe("recent")
    expect(parseSort("relevance")).toBe("relevance")
    expect(parseSort("garbage")).toBe(DEFAULT_SORT)
    expect(parseSort(null)).toBe(DEFAULT_SORT)
    expect(parseSort(undefined)).toBe(DEFAULT_SORT)
  })
})
