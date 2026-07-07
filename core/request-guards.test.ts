import { describe, expect, it } from "vitest"
// @ts-expect-error — CJS module, no types
import { isValidConfig, isValidPinsArray } from "./request-guards.js"

describe("isValidConfig", () => {
  it("accepts a well-shaped host/port config", () => {
    expect(isValidConfig({ host: "10.0.0.1", port: 9222 })).toBe(true)
    expect(isValidConfig({ host: "example.test", port: "9222" })).toBe(true)
  })

  it("rejects the empty / masked-body object that would wipe the CDP address", () => {
    expect(isValidConfig({})).toBe(false)
  })

  it("rejects a missing/blank host or non-numeric port", () => {
    expect(isValidConfig({ host: "", port: 9222 })).toBe(false)
    expect(isValidConfig({ host: "h", port: "nope" })).toBe(false)
    expect(isValidConfig({ port: 9222 })).toBe(false)
    expect(isValidConfig(null)).toBe(false)
  })
})

describe("isValidPinsArray", () => {
  it("accepts an array of pin objects with string ids", () => {
    expect(isValidPinsArray([{ id: "p1" }, { id: "p2", url: "https://x" }])).toBe(true)
    expect(isValidPinsArray([])).toBe(true)
  })

  it("rejects non-arrays and arrays with malformed members", () => {
    expect(isValidPinsArray({})).toBe(false)
    expect(isValidPinsArray(null)).toBe(false)
    expect(isValidPinsArray([{ id: "p1" }, { url: "no-id" }])).toBe(false)
    expect(isValidPinsArray([{ id: 5 }])).toBe(false)
  })
})
