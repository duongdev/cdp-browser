import { describe, expect, it } from "vitest"
import { EMPTY_LOCAL_TABS, isLocalTabsEnabled } from "./use-local-tabs"

// The hook itself is React glue (state + effects), verified visually (Layer 3).
// Its pure, load-bearing parts — the gate decision and the frozen empty/no-op
// surface — are tested here. See docs/conventions/feature-gates.md + tdd.md.

describe("isLocalTabsEnabled", () => {
  it("is true under Electron (full capability)", () => {
    expect(isLocalTabsEnabled({ web: false, localTabs: true, extensions: true })).toBe(true)
  })

  it("is false on the web build (restricted capability)", () => {
    expect(isLocalTabsEnabled({ web: true, localTabs: false, extensions: false })).toBe(false)
  })
})

describe("EMPTY_LOCAL_TABS — the gated surface returned when local tabs are off", () => {
  it("holds an empty list and no active local tab (activeKind pinned to cdp)", () => {
    expect(EMPTY_LOCAL_TABS.localTabs).toEqual([])
    expect(EMPTY_LOCAL_TABS.localActiveId).toBeNull()
    expect(EMPTY_LOCAL_TABS.activeLocalTab).toBeNull()
    expect(EMPTY_LOCAL_TABS.activeKind).toBe("cdp")
    expect(EMPTY_LOCAL_TABS.localQuickLaunch).toEqual([])
  })

  it("every handler is inert — returns nothing, throws nothing, mutates nothing", () => {
    // None of these reach window.local / DOM; calling them is a structural no-op.
    expect(() => EMPTY_LOCAL_TABS.setActiveKindCdp()).not.toThrow()
    expect(() => EMPTY_LOCAL_TABS.closeLocalTab("x")).not.toThrow()
    expect(() => EMPTY_LOCAL_TABS.switchLocalTab("x")).not.toThrow()
    expect(() => EMPTY_LOCAL_TABS.patchLocalTab("x", { title: "y" })).not.toThrow()
    expect(() => EMPTY_LOCAL_TABS.toggleLocalPin("x")).not.toThrow()
    expect(() => EMPTY_LOCAL_TABS.reorderLocalTabs([])).not.toThrow()
    expect(() => EMPTY_LOCAL_TABS.handleEditLocalSave("x", "t", "u")).not.toThrow()
    expect(() => EMPTY_LOCAL_TABS.restoreLocalTabs(true)).not.toThrow()
  })

  it("createLocalTab resolves to an empty id without opening anything", async () => {
    await expect(EMPTY_LOCAL_TABS.createLocalTab("https://x")).resolves.toBe("")
  })

  it("is frozen so consumers can't mutate the shared empty surface", () => {
    expect(Object.isFrozen(EMPTY_LOCAL_TABS)).toBe(true)
  })

  it("returns the same reference each access — consumers never re-subscribe on web", () => {
    // The module-level constant is identity-stable; the no-op handlers don't churn.
    const a = EMPTY_LOCAL_TABS
    const b = EMPTY_LOCAL_TABS
    expect(a.closeLocalTab).toBe(b.closeLocalTab)
    expect(a.switchLocalTab).toBe(b.switchLocalTab)
    expect(a).toBe(b)
  })
})
