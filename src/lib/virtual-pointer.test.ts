import { describe, expect, it } from "vitest"
import { nextVirtualPointerMode, parseMode, shouldShowVirtualPointer } from "./virtual-pointer"

describe("virtual-pointer — shouldShowVirtualPointer (write first)", () => {
  it("off never shows, regardless of pointer", () => {
    expect(shouldShowVirtualPointer("off", true)).toBe(false)
    expect(shouldShowVirtualPointer("off", false)).toBe(false)
  })

  it("on always shows, regardless of pointer", () => {
    expect(shouldShowVirtualPointer("on", true)).toBe(true)
    expect(shouldShowVirtualPointer("on", false)).toBe(true)
  })

  it("auto shows only when there is no fine pointer", () => {
    expect(shouldShowVirtualPointer("auto", false)).toBe(true) // coarse-only (bare iPad)
    expect(shouldShowVirtualPointer("auto", true)).toBe(false) // trackpad attached
  })
})

describe("virtual-pointer — parseMode", () => {
  it("returns each valid mode unchanged", () => {
    expect(parseMode("off")).toBe("off")
    expect(parseMode("on")).toBe("on")
    expect(parseMode("auto")).toBe("auto")
  })

  it("falls back to auto for garbage", () => {
    expect(parseMode("nonsense")).toBe("auto")
    expect(parseMode("OFF")).toBe("auto") // case-sensitive
    expect(parseMode("")).toBe("auto")
  })

  it("falls back to auto for null/undefined", () => {
    expect(parseMode(null)).toBe("auto")
    expect(parseMode(undefined)).toBe("auto")
  })
})

describe("virtual-pointer — nextVirtualPointerMode", () => {
  it("cycles off → on → auto → off", () => {
    expect(nextVirtualPointerMode("off")).toBe("on")
    expect(nextVirtualPointerMode("on")).toBe("auto")
    expect(nextVirtualPointerMode("auto")).toBe("off")
  })
})
