import { describe, expect, test } from "vitest"
import { extractCitations } from "./assistant-citations"

describe("extractCitations", () => {
  test("strips markers, collects citations in order", () => {
    const r = extractCitations("Bob said done [msg:c1:m2] and later [msg:c2:m9].")
    expect(r.text).toBe("Bob said done and later .")
    expect(r.citations).toEqual([
      { convId: "c1", msgId: "m2" },
      { convId: "c2", msgId: "m9" },
    ])
  })

  test("Teams conv ids with colons split on last colon", () => {
    const r = extractCitations("[msg:19:a_b@unq.gbl.spaces:1721990000000]")
    expect(r.citations).toEqual([{ convId: "19:a_b@unq.gbl.spaces", msgId: "1721990000000" }])
  })

  test("dedupes, malformed degrades to removal", () => {
    const r = extractCitations("[msg:c1:m1] [msg:c1:m1] [msg:broken]")
    expect(r.citations).toHaveLength(1)
    expect(r.text.trim()).toBe("")
  })

  test("no markers → text unchanged", () => {
    expect(extractCitations("plain **markdown**").text).toBe("plain **markdown**")
    expect(extractCitations("").citations).toEqual([])
  })
})
