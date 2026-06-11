import { describe, expect, it } from "vitest"
import { shellModeFor, shouldApplyAdaptive } from "./shell-mode"

describe("shellModeFor", () => {
  it("returns phone below the breakpoint", () => {
    expect(shellModeFor(390)).toBe("phone")
    expect(shellModeFor(767)).toBe("phone")
  })

  it("returns wide at and above the breakpoint", () => {
    expect(shellModeFor(768)).toBe("wide")
    expect(shellModeFor(1440)).toBe("wide")
  })
})

describe("shouldApplyAdaptive", () => {
  it("never applies on the phone shell, even when the setting is on", () => {
    expect(shouldApplyAdaptive(true, "phone")).toBe(false)
  })

  it("follows the setting on the wide shell", () => {
    expect(shouldApplyAdaptive(true, "wide")).toBe(true)
    expect(shouldApplyAdaptive(false, "wide")).toBe(false)
  })

  it("stays off on phone when the setting is off", () => {
    expect(shouldApplyAdaptive(false, "phone")).toBe(false)
  })
})
