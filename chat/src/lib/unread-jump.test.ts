import { describe, expect, it } from "vitest"
import { shouldShowUnreadJump } from "./unread-jump"

describe("shouldShowUnreadJump", () => {
  it("shows when separator exists, unseen, and above viewport", () => {
    expect(
      shouldShowUnreadJump({
        hasSeparator: true,
        separatorSeen: false,
        separatorAboveViewport: true,
      }),
    ).toBe(true)
  })

  it("hides when no separator", () => {
    expect(
      shouldShowUnreadJump({
        hasSeparator: false,
        separatorSeen: false,
        separatorAboveViewport: true,
      }),
    ).toBe(false)
  })

  it("hides once seen (even if still above viewport)", () => {
    expect(
      shouldShowUnreadJump({
        hasSeparator: true,
        separatorSeen: true,
        separatorAboveViewport: true,
      }),
    ).toBe(false)
  })

  it("hides when separator is in viewport or below", () => {
    expect(
      shouldShowUnreadJump({
        hasSeparator: true,
        separatorSeen: false,
        separatorAboveViewport: false,
      }),
    ).toBe(false)
  })
})
