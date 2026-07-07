import { describe, expect, it } from "vitest"
// @ts-expect-error — CJS module, no types
import { isClientDead, shouldSkipClient } from "./ws-backpressure.js"

describe("shouldSkipClient", () => {
  it("skips a client whose send buffer is over the cap (fresh-frame-wins)", () => {
    expect(shouldSkipClient(9_000_000, 8_000_000)).toBe(true)
  })

  it("serves a client at or under the cap", () => {
    expect(shouldSkipClient(8_000_000, 8_000_000)).toBe(false)
    expect(shouldSkipClient(0, 8_000_000)).toBe(false)
  })

  it("disables skipping when the cap is non-positive", () => {
    expect(shouldSkipClient(999_999_999, 0)).toBe(false)
    expect(shouldSkipClient(999_999_999, -1)).toBe(false)
  })
})

describe("isClientDead", () => {
  it("is dead when no liveness signal arrived within the deadline", () => {
    expect(isClientDead(1000, 1000 + 61_000, 60_000)).toBe(true)
  })

  it("is alive when a signal arrived within the deadline", () => {
    expect(isClientDead(1000, 1000 + 30_000, 60_000)).toBe(false)
  })

  it("treats a missing lastSeenAt as long-dead (evicts a never-ponged socket past the deadline)", () => {
    expect(isClientDead(undefined, 100_000, 60_000)).toBe(true)
  })
})
