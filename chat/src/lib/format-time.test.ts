import { describe, expect, it } from "vitest"
import { formatHms } from "./format-time"

describe("formatHms", () => {
  it("zero-pads to HH:mm:ss", () => {
    const ts = new Date(2026, 0, 2, 9, 5, 7).getTime()
    expect(formatHms(ts)).toBe("09:05:07")
  })
  it("uses 24-hour clock", () => {
    const ts = new Date(2026, 0, 2, 23, 59, 59).getTime()
    expect(formatHms(ts)).toBe("23:59:59")
  })
  it("returns empty string for invalid input", () => {
    expect(formatHms(Number.NaN)).toBe("")
  })
})
