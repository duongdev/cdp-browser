import { describe, expect, it } from "vitest"
import { applySuggestion, detectSuggestion } from "./search-suggest"

describe("detectSuggestion", () => {
  it("detects an open from: token at the caret", () => {
    const q = "from:an"
    const r = detectSuggestion(q, q.length)
    expect(r).toEqual({ kind: "from", partial: "an", start: 0, end: q.length, quoted: false })
  })

  it("detects in: mid-query", () => {
    const q = "deploy in:proj"
    const r = detectSuggestion(q, q.length)
    expect(r?.kind).toBe("in")
    expect(r?.partial).toBe("proj")
    expect(r?.start).toBe(7) // the 'i' of 'in:'
  })

  it("strips an opening quote from the partial", () => {
    const q = 'from:"an'
    const r = detectSuggestion(q, q.length)
    expect(r?.partial).toBe("an")
    expect(r?.quoted).toBe(true)
  })

  it("returns null when no operator is open", () => {
    expect(detectSuggestion("deploy plan", 11)).toBeNull()
    expect(detectSuggestion("", 0)).toBeNull()
  })

  it("returns null once an unquoted value is closed by a space", () => {
    // `from:ann ` — the trailing space ended the token; caret is past it into free text.
    expect(detectSuggestion("from:ann deploy", 9)).toBeNull()
  })

  it("returns null for a closed quoted value", () => {
    // `from:"ann wong"` — caret past the closing quote → token ended.
    expect(detectSuggestion('from:"ann wong"', 'from:"ann wong"'.length)).toBeNull()
  })

  it("keeps a quoted value open across spaces until the closing quote", () => {
    const q = 'from:"ann wo'
    const r = detectSuggestion(q, q.length)
    expect(r?.partial).toBe("ann wo")
    expect(r?.quoted).toBe(true)
  })

  it("doesn't match in: inside another word (join:)", () => {
    expect(detectSuggestion("join:foo", 8)).toBeNull()
  })

  it("ignores other operators (after:/has:/mentions:)", () => {
    expect(detectSuggestion("after:2026", 10)).toBeNull()
    expect(detectSuggestion("has:link", 9)).toBeNull()
    expect(detectSuggestion("mentions:me", 11)).toBeNull()
  })

  it("clamps a negative / over-long caret", () => {
    expect(detectSuggestion("from:an", -5)).toBeNull()
    expect(detectSuggestion("from:an", 999)?.partial).toBe("an")
  })
})

describe("applySuggestion", () => {
  it("inserts a single-word value bare + trailing space, caret after the token", () => {
    const q = "from:an"
    const r = detectSuggestion(q, q.length)!
    expect(applySuggestion(q, r, "Ann")).toEqual({ value: "from:Ann ", caret: 8 })
  })

  it("quotes a multi-word value", () => {
    const q = 'from:"an'
    const r = detectSuggestion(q, q.length)!
    const out = applySuggestion(q, r, "Ann Wong")
    expect(out.value).toBe('from:"Ann Wong" ')
    expect(out.caret).toBe('from:"Ann Wong"'.length)
  })

  it("escapes embedded quotes (single word stays bare)", () => {
    const q = "from:a"
    const r = detectSuggestion(q, q.length)!
    expect(applySuggestion(q, r, 'weird"name').value).toBe("from:weirdname ")
  })

  it("preserves free text before and after the replaced range (no trailing space mid-query)", () => {
    const q = "deploy in:pr now"
    // caret right after 'pr' (index 12), before the space + 'now'
    const r = detectSuggestion(q, 12)!
    expect(r.kind).toBe("in")
    // Replace the `in:pr` range, leave 'deploy ' before and ' now' after; NO extra trailing space
    // because the caret wasn't at the end of the query.
    const out = applySuggestion(q, r, "Project X")
    expect(out.value).toBe('deploy in:"Project X" now')
    expect(out.caret).toBe('deploy in:"Project X"'.length)
  })
})
