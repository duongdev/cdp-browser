import { describe, expect, test } from "vitest"
import { shiftEnterAction } from "./composer-keys"

describe("shiftEnterAction", () => {
  test("plain paragraph → splitBlock (new paragraph)", () => {
    expect(shiftEnterAction(false, false)).toBe("splitBlock")
  })
  test("inside a list item → native (HardBreak within the item)", () => {
    expect(shiftEnterAction(true, false)).toBe("native")
  })
  test("inside a code block → native (newline within the block)", () => {
    expect(shiftEnterAction(false, true)).toBe("native")
  })
  test("list + code block together → native", () => {
    expect(shiftEnterAction(true, true)).toBe("native")
  })
})
