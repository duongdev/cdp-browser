import { describe, expect, it } from "vitest"
import { diffInput } from "./text-input-delta"

describe("diffInput", () => {
  it("no change → nothing", () => {
    expect(diffInput("abc", "abc")).toEqual({ backspaces: 0, insert: "" })
  })

  it("plain append inserts the new suffix", () => {
    expect(diffInput("hel", "hello")).toEqual({ backspaces: 0, insert: "lo" })
  })

  it("typing from empty", () => {
    expect(diffInput("", "a")).toEqual({ backspaces: 0, insert: "a" })
  })

  it("autocorrect replacement deletes the changed tail then retypes it", () => {
    // "teh" → "the": common prefix "t", delete "eh" (2), insert "he".
    expect(diffInput("teh", "the")).toEqual({ backspaces: 2, insert: "he" })
  })

  it("Vietnamese composition: base vowel becomes a diacritic glyph", () => {
    // Telex: "viet" → "việt" — the field rewrites the tail with the composed form.
    expect(diffInput("viet", "việt")).toEqual({ backspaces: 2, insert: "ệt" })
  })

  it("deletion removes from the tail", () => {
    expect(diffInput("hello", "hell")).toEqual({ backspaces: 1, insert: "" })
  })

  it("full replace when nothing matches", () => {
    expect(diffInput("abc", "xyz")).toEqual({ backspaces: 3, insert: "xyz" })
  })
})
