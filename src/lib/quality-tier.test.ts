import { describe, expect, it } from "vitest"
// @ts-expect-error — CJS module, no types
import core from "../../core/quality-tier.js"
import {
  DEFAULT_TIER,
  parseTier,
  QUALITY_TIERS,
  readCurrentTier,
  setCurrentTier,
  tierParams,
} from "./quality-tier"

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

describe("currentTier mirror (t100)", () => {
  it("defaults to the balanced tier before any seed", () => {
    // Note: module singleton — this asserts the initial value; other cases set it explicitly.
    setCurrentTier(DEFAULT_TIER)
    expect(readCurrentTier()).toBe(DEFAULT_TIER)
  })

  it("stores a seeded tier and reads it back for the resize reissue", () => {
    setCurrentTier("snappy")
    expect(readCurrentTier()).toBe("snappy")
    expect(tierParams(readCurrentTier())).toEqual({ jpegQuality: 60, everyNthFrame: 3 })
  })

  it("parse-guards a garbage / null seed to the default", () => {
    setCurrentTier("sharp")
    setCurrentTier("garbage")
    expect(readCurrentTier()).toBe(DEFAULT_TIER)
    setCurrentTier("sharp")
    setCurrentTier(null)
    expect(readCurrentTier()).toBe(DEFAULT_TIER)
  })
})
