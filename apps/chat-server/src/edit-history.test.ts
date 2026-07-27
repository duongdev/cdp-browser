import { describe, expect, test } from "vitest"
import { planSnapshot } from "./edit-history.ts"

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
})
