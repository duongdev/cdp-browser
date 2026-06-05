import { describe, expect, it } from "vitest"
import { isTypingSurface } from "./typing-surface"

describe("isTypingSurface", () => {
  it("returns true for cdp", () => {
    expect(isTypingSurface("cdp")).toBe(true)
  })

  it("returns true for local", () => {
    expect(isTypingSurface("local")).toBe(true)
  })

  it("returns false for chrome (app chrome)", () => {
    expect(isTypingSurface("chrome")).toBe(false)
  })
})
