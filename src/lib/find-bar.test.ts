import { describe, expect, it } from "vitest"
import { closedFindState, counterLabel, type FindState, reduce } from "./find-bar"

const open: FindState = { open: true, query: "", currentIndex: 0, total: 0 }
const matched = (overrides: Partial<FindState> = {}): FindState => ({
  open: true,
  query: "foo",
  currentIndex: 0,
  total: 12,
  ...overrides,
})

describe("closedFindState", () => {
  it("is closed with an empty query and zero counts", () => {
    expect(closedFindState).toEqual({ open: false, query: "", currentIndex: 0, total: 0 })
  })
})

describe("reduce — open / close", () => {
  it("open transitions closed→open with an empty query and zero baseline", () => {
    expect(reduce(closedFindState, { type: "open" })).toEqual({
      open: true,
      query: "",
      currentIndex: 0,
      total: 0,
    })
  })

  it("open while already open keeps the existing query (re-focus is the caller's job)", () => {
    const state = matched({ currentIndex: 4 })
    expect(reduce(state, { type: "open" })).toBe(state)
  })

  it("close resets query, current index, and total to the closed baseline", () => {
    expect(reduce(matched({ currentIndex: 7 }), { type: "close" })).toEqual(closedFindState)
  })
})

describe("reduce — setQuery", () => {
  it("records the query and resets the count to a pending zero state", () => {
    expect(reduce(open, { type: "setQuery", query: "abc" })).toEqual({
      open: true,
      query: "abc",
      currentIndex: 0,
      total: 0,
    })
  })

  it("an empty query resets the count", () => {
    expect(reduce(matched({ currentIndex: 5 }), { type: "setQuery", query: "" })).toEqual({
      open: true,
      query: "",
      currentIndex: 0,
      total: 0,
    })
  })
})

describe("reduce — setTotal", () => {
  it("records the reported total and clamps current into [0, total)", () => {
    expect(reduce(matched({ currentIndex: 99 }), { type: "setTotal", total: 12 })).toEqual(
      matched({ currentIndex: 11, total: 12 }),
    )
  })

  it("a zero total is the no-match state at index 0", () => {
    expect(reduce(matched({ currentIndex: 3 }), { type: "setTotal", total: 0 })).toEqual(
      matched({ currentIndex: 0, total: 0 }),
    )
  })

  it("keeps a valid current index in range", () => {
    expect(
      reduce(matched({ currentIndex: 5, total: 12 }), { type: "setTotal", total: 12 }),
    ).toEqual(matched({ currentIndex: 5, total: 12 }))
  })
})

describe("reduce — next / prev (wrap)", () => {
  it("next advances the current index", () => {
    expect(reduce(matched({ currentIndex: 0 }), { type: "next" }).currentIndex).toBe(1)
  })

  it("next wraps last→first", () => {
    expect(reduce(matched({ currentIndex: 11, total: 12 }), { type: "next" }).currentIndex).toBe(0)
  })

  it("prev steps back", () => {
    expect(reduce(matched({ currentIndex: 5 }), { type: "prev" }).currentIndex).toBe(4)
  })

  it("prev wraps first→last", () => {
    expect(reduce(matched({ currentIndex: 0, total: 12 }), { type: "prev" }).currentIndex).toBe(11)
  })

  it("next is a no-op when there are no matches", () => {
    const noMatch = matched({ currentIndex: 0, total: 0 })
    expect(reduce(noMatch, { type: "next" })).toBe(noMatch)
  })

  it("prev is a no-op when there are no matches", () => {
    const noMatch = matched({ currentIndex: 0, total: 0 })
    expect(reduce(noMatch, { type: "prev" })).toBe(noMatch)
  })
})

describe("counterLabel", () => {
  it("is empty for an empty query", () => {
    expect(counterLabel(open)).toBe("")
  })

  it("shows 1-based current/total for matches", () => {
    expect(counterLabel(matched({ currentIndex: 2, total: 12 }))).toBe("3/12")
  })

  it("shows the no-match state for a non-empty query with zero results", () => {
    expect(counterLabel(matched({ currentIndex: 0, total: 0 }))).toBe("0/0")
  })
})
