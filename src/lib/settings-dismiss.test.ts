import { describe, expect, it } from "vitest"
import { shouldArmLeaveTimer } from "./settings-dismiss"

describe("shouldArmLeaveTimer", () => {
  it("arms on a fine pointer when not committed and no Select is open", () => {
    expect(shouldArmLeaveTimer({ pointerFine: true, committed: false, selectOpen: false })).toBe(
      true,
    )
  })

  it("never arms on a coarse pointer — a touch-synthesized mouseleave is inert", () => {
    expect(shouldArmLeaveTimer({ pointerFine: false, committed: false, selectOpen: false })).toBe(
      false,
    )
    // Coarse stays inert regardless of the other flags.
    expect(shouldArmLeaveTimer({ pointerFine: false, committed: true, selectOpen: false })).toBe(
      false,
    )
    expect(shouldArmLeaveTimer({ pointerFine: false, committed: false, selectOpen: true })).toBe(
      false,
    )
  })

  it("never arms a committed (keyboard / Cmd+,) drawer, even on a fine pointer", () => {
    expect(shouldArmLeaveTimer({ pointerFine: true, committed: true, selectOpen: false })).toBe(
      false,
    )
  })

  it("never arms while a Select popover is open (cursor legitimately off-panel)", () => {
    expect(shouldArmLeaveTimer({ pointerFine: true, committed: false, selectOpen: true })).toBe(
      false,
    )
  })
})
