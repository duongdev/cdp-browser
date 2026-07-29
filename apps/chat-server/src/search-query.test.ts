// Unit tests for the KQL-style search query parser (PSN-115 WS-D). Pure: parse in, structured
// query out — no I/O, no date clock beyond what Date.parse gives us. Every operator has a "happy"
// case, an "unknown → literal" case, and (where relevant) a quoted-value case. Vietnamese + CJK
// free text must round-trip byte-for-byte (the parser must never fold or mangle user text).

import { describe, expect, test } from "vitest"
import { parseQuery } from "./search-query.ts"

describe("parseQuery — free text", () => {
  test("empty query → empty text, no filters", () => {
    expect(parseQuery("")).toEqual({ text: "", filters: {} })
  })
  test("whitespace-only → empty", () => {
    expect(parseQuery("   ")).toEqual({ text: "", filters: {} })
  })
  test("single word → text", () => {
    expect(parseQuery("hello")).toEqual({ text: "hello", filters: {} })
  })
  test("multiple words → space-joined text", () => {
    expect(parseQuery("hello world foo")).toEqual({ text: "hello world foo", filters: {} })
  })
  test("Vietnamese preserved byte-for-byte", () => {
    expect(parseQuery("Đà Nẵng đường phố").text).toBe("Đà Nẵng đường phố")
  })
  test("CJK preserved byte-for-byte", () => {
    expect(parseQuery("你好 世界").text).toBe("你好 世界")
  })
  test("collapses internal whitespace", () => {
    expect(parseQuery("a   b\tc").text).toBe("a b c")
  })
})

describe("parseQuery — from:", () => {
  test("bare name", () => {
    expect(parseQuery("from:alice hello").filters).toEqual({ from: "alice" })
    expect(parseQuery("from:alice hello").text).toBe("hello")
  })
  test("strips leading @", () => {
    expect(parseQuery("from:@alice").filters).toEqual({ from: "alice" })
  })
  test("quoted name keeps spaces", () => {
    expect(parseQuery('from:"Alice Wong" hi').filters).toEqual({ from: "Alice Wong" })
  })
  test("two from: → last wins (Slack behaviour)", () => {
    expect(parseQuery("from:alice from:bob").filters).toEqual({ from: "bob" })
  })
})

describe("parseQuery — in:", () => {
  test("strips leading #", () => {
    expect(parseQuery("in:#general").filters).toEqual({ in: "general" })
  })
  test("quoted multi-word channel name", () => {
    expect(parseQuery('in:"design review" deployed').filters).toEqual({ in: "design review" })
  })
  test("raw conversation id passes through", () => {
    expect(parseQuery("in:19:group@thread.v2").filters).toEqual({ in: "19:group@thread.v2" })
  })
})

describe("parseQuery — after: / before:", () => {
  test("ISO date → epoch ms (UTC midnight)", () => {
    const f = parseQuery("after:2026-07-01").filters
    expect(f.afterTs).toBe(Date.parse("2026-07-01"))
    expect(typeof f.afterTs).toBe("number")
  })
  test("4-digit year → Jan 1 UTC of that year", () => {
    const f = parseQuery("before:2025").filters
    expect(f.beforeTs).toBe(Date.UTC(2025, 0, 1))
  })
  test("both bounds at once", () => {
    const f = parseQuery("after:2026-01-01 before:2026-12-31").filters
    expect(f.afterTs).toBe(Date.parse("2026-01-01"))
    expect(f.beforeTs).toBe(Date.parse("2026-12-31"))
  })
  test("unparseable date → operator stays as literal text", () => {
    const r = parseQuery("after:banana split")
    expect(r.filters.afterTs).toBeUndefined()
    expect(r.text).toBe("after:banana split")
  })
})

describe("parseQuery — has:", () => {
  test("single has", () => {
    expect(parseQuery("has:link").filters).toEqual({ has: ["link"] })
  })
  test("multiple has accumulate, order preserved", () => {
    expect(parseQuery("has:link has:file has:attachment").filters).toEqual({
      has: ["link", "file", "attachment"],
    })
  })
  test("has with unknown value still parsed (let caller decide)", () => {
    expect(parseQuery("has:banana").filters).toEqual({ has: ["banana"] })
  })
})

describe("parseQuery — mentions:me", () => {
  test("mentions:me sets the flag", () => {
    expect(parseQuery("mentions:me hi").filters).toEqual({ mentionsMe: true })
  })
  test("mentions:someone-else is NOT the me flag (drops to no filter)", () => {
    // Only `me` is meaningful today; anything else is ignored as a filter and NOT eaten as text
    // (matches Slack's "mentions:me" being the only supported form). The token doesn't join `text`.
    const r = parseQuery("mentions:bob hi")
    expect(r.filters.mentionsMe).toBeUndefined()
    expect(r.text).toBe("hi")
  })
})

describe("parseQuery — unknown operators", () => {
  test("unknown key:value treated as literal text", () => {
    expect(parseQuery("foo:bar baz").text).toBe("foo:bar baz")
  })
  test("unknown operator with quotes re-emitted verbatim", () => {
    // Unknown `foo:` → the token falls through to literal text, re-emitted AS TYPED (quotes kept).
    // The user typed it; the search engine decides whether to match the literal form. We never
    // silently rewrite user text.
    expect(parseQuery('foo:"bar baz"').text).toBe('foo:"bar baz"')
  })
  test("key with no value → literal", () => {
    expect(parseQuery("just: text").text).toBe("just: text")
  })
})

describe("parseQuery — mixed real-world queries", () => {
  test("from + in + free text", () => {
    const r = parseQuery("from:@alice in:#deploy anyone seen the rollback?")
    expect(r.filters).toEqual({ from: "alice", in: "deploy" })
    expect(r.text).toBe("anyone seen the rollback?")
  })
  test("all operators together", () => {
    const r = parseQuery(
      "from:bob in:design after:2026-06-01 before:2026-07-28 has:link has:file mentions:me ship it",
    )
    expect(r.filters).toEqual({
      from: "bob",
      in: "design",
      afterTs: Date.parse("2026-06-01"),
      beforeTs: Date.parse("2026-07-28"),
      has: ["link", "file"],
      mentionsMe: true,
    })
    expect(r.text).toBe("ship it")
  })
  test("quoted operator adjacent to free text preserves spacing", () => {
    const r = parseQuery('from:"Bob Lee" shipped today')
    expect(r.filters).toEqual({ from: "Bob Lee" })
    expect(r.text).toBe("shipped today")
  })
})
