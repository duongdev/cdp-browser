import { describe, expect, test } from "vitest"
import { planSnapshot, resolveBody } from "./edit-history.ts"

const NOW = 1_700_000_000_000

describe("planSnapshot", () => {
  test("keeps the old body when the text changed", () => {
    expect(planSnapshot({ body: "one", deleted: false }, { body: "two", editTs: 42 }, NOW)).toEqual(
      {
        body: "one",
        editTs: 42,
      },
    )
  })

  test("falls back to now when the provider sends no edit stamp", () => {
    expect(planSnapshot({ body: "one", deleted: false }, { body: "two" }, NOW)).toEqual({
      body: "one",
      editTs: NOW,
    })
  })

  test("keeps the real text when the message flips to deleted", () => {
    const out = planSnapshot(
      { body: "secret", deleted: false },
      { body: "message deleted", deleted: true },
      NOW,
    )
    expect(out).toEqual({ body: "secret", editTs: NOW })
  })

  test("returns null for a first sight, an unchanged body, or an already-deleted row", () => {
    expect(planSnapshot(null, { body: "one" }, NOW)).toBeNull()
    expect(planSnapshot({ body: "one", deleted: false }, { body: "one" }, NOW)).toBeNull()
    expect(
      planSnapshot(
        { body: "message deleted", deleted: true },
        { body: "message deleted", deleted: true },
        NOW,
      ),
    ).toBeNull()
  })

  test("ignores an empty incoming body on a live message (a partial payload, not an edit)", () => {
    expect(planSnapshot({ body: "one", deleted: false }, { body: "" }, NOW)).toBeNull()
    expect(planSnapshot({ body: "   ", deleted: false }, { body: "two" }, NOW)).toBeNull()
  })

  // DEF-2: a message edited and later deleted still carries the OLD edittime, which dated the
  // delete's snapshot to when that body was written.
  test("stamps a delete with now, never the superseded body's edit time", () => {
    expect(
      planSnapshot(
        { body: "secret", deleted: false },
        { body: "", deleted: true, editTs: 42 },
        NOW,
      ),
    ).toEqual({ body: "secret", editTs: NOW })
  })
})

describe("resolveBody", () => {
  // DEF-1: the blank payload the snapshot refuses to record must not be written either.
  test("keeps the stored text when a live message arrives blank", () => {
    expect(resolveBody({ body: "hi there", deleted: false }, { body: "" })).toBe("hi there")
    expect(resolveBody({ body: "hi there", deleted: false }, { body: "   " })).toBe("hi there")
    expect(resolveBody({ body: "hi there", deleted: false }, {})).toBe("hi there")
  })

  test("a delete always wins, whatever tombstone body the provider sends", () => {
    expect(resolveBody({ body: "secret", deleted: false }, { body: "", deleted: true })).toBe("")
    expect(
      resolveBody({ body: "secret", deleted: false }, { body: "message deleted", deleted: true }),
    ).toBe("message deleted")
  })

  test("a real body always writes, and a first sight writes whatever arrived", () => {
    expect(resolveBody({ body: "one", deleted: false }, { body: "two" })).toBe("two")
    expect(resolveBody(null, { body: "" })).toBe("")
    expect(resolveBody({ body: "", deleted: false }, { body: "" })).toBe("")
    expect(resolveBody({ body: "gone", deleted: true }, { body: "" })).toBe("")
  })
})
