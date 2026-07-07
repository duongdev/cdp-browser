import { describe, expect, it } from "vitest"
// @ts-expect-error — CJS module, no types
import core from "../../core/quality-tier.js"
import { DEFAULT_TIER, parseTier, QUALITY_TIERS, tierParams } from "./quality-tier"

describe("parseTier", () => {
  it("passes through known ids and defaults garbage", () => {
    expect(parseTier("sharp")).toBe("sharp")
    expect(parseTier("snappy")).toBe("snappy")
    expect(parseTier("nope")).toBe(DEFAULT_TIER)
    expect(parseTier(null)).toBe(DEFAULT_TIER)
    expect(parseTier(undefined)).toBe(DEFAULT_TIER)
  })
})

describe("tierParams", () => {
  it("returns the screencast params for a tier and defaults an unknown one", () => {
    expect(tierParams("sharp")).toEqual({ jpegQuality: 92, everyNthFrame: 1 })
    expect(tierParams("snappy")).toEqual({ jpegQuality: 60, everyNthFrame: 3 })
    expect(tierParams("garbage")).toEqual(tierParams(DEFAULT_TIER))
  })

  // Parity guard: the renderer mirror must match the server-owner (core/quality-tier.js), or a
  // resize reissue would drift the tier from what the connect path applied (t099, ADR-0008).
  it("mirrors core/quality-tier.js tierToParams exactly for every tier", () => {
    for (const { id } of QUALITY_TIERS) {
      expect(tierParams(id)).toEqual(core.tierToParams(id))
    }
  })
})
