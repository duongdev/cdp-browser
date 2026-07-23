import { describe, expect, it } from "vitest"
import { filterRoster, mentionQuery } from "./mention"

describe("mentionQuery", () => {
  it("detects an @query at the caret after whitespace or start", () => {
    expect(mentionQuery("@du")).toEqual({ query: "du", at: 0 })
    expect(mentionQuery("hi @gl")).toEqual({ query: "gl", at: 3 })
    expect(mentionQuery("@")).toEqual({ query: "", at: 0 })
  })
  it("ignores an @ inside a word (e.g. an email)", () => {
    expect(mentionQuery("mail me at a@b")).toBeNull()
  })
  it("closes the query at whitespace", () => {
    expect(mentionQuery("@glory done")).toBeNull()
  })
})

describe("filterRoster", () => {
  const roster = [
    { mri: "1", name: "Glory Nguyen - Group Office [C]" },
    { mri: "2", name: "Careen Tan - Group Office" },
    { mri: "3", name: "Dustin Do - Group Office [C]" },
  ]

  it("empty query returns everyone in name order", () => {
    expect(filterRoster(roster, "").map((m) => m.mri)).toEqual(["2", "3", "1"])
  })
  it("matches a name-word prefix (diacritic/case-insensitive)", () => {
    expect(filterRoster(roster, "glo").map((m) => m.mri)).toEqual(["1"])
    expect(filterRoster(roster, "dus").map((m) => m.mri)).toEqual(["3"])
  })
  it("is Vietnamese-diacritic-safe", () => {
    expect(filterRoster([{ mri: "x", name: "Dương Đỗ" }], "duong").map((m) => m.mri)).toEqual(["x"])
  })
  it("ranks a word-prefix hit above a loose substring hit", () => {
    const r = [
      { mri: "sub", name: "Backoffice Bot" }, // "off" is only a substring
      { mri: "pre", name: "Office Team" }, // a word starts with "off"
    ]
    expect(filterRoster(r, "off").map((m) => m.mri)).toEqual(["pre", "sub"])
  })
})
