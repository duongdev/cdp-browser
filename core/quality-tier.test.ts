import { describe, expect, it } from "vitest"
// Root CJS shared core (ADR-0008): the single owner of the Sharp/Balanced/Snappy
// screencast presets, consumed by remote-page-connector.js + main.js + the web picker.
import { DEFAULT_TIER, parseTier, TIERS, tierToParams } from "./quality-tier"

const ORDER = ["sharp", "balanced", "snappy"]

describe("tierToParams", () => {
  it("maps sharp to its exact params", () => {
    expect(tierToParams("sharp")).toEqual({ jpegQuality: 92, everyNthFrame: 1 })
  })

  it("maps balanced to today's behavior (quality 80, everyNthFrame 2)", () => {
    expect(tierToParams("balanced")).toEqual({ jpegQuality: 80, everyNthFrame: 2 })
  })

  it("maps snappy to its exact params", () => {
    expect(tierToParams("snappy")).toEqual({ jpegQuality: 60, everyNthFrame: 3 })
  })

  it("falls back to the default tier's params for an unknown tier", () => {
    expect(tierToParams("turbo")).toEqual(tierToParams(DEFAULT_TIER))
  })

  it("is monotonic: jpegQuality strictly decreases sharp → balanced → snappy", () => {
    const qualities = ORDER.map((t) => tierToParams(t).jpegQuality)
    for (let i = 1; i < qualities.length; i++) {
      expect(qualities[i]).toBeLessThan(qualities[i - 1])
    }
  })

  it("is monotonic: everyNthFrame is non-decreasing sharp → balanced → snappy", () => {
    const frames = ORDER.map((t) => tierToParams(t).everyNthFrame)
    for (let i = 1; i < frames.length; i++) {
      expect(frames[i]).toBeGreaterThanOrEqual(frames[i - 1])
    }
  })

  it("never emits everyNthFrame below 1 (Chromium rejects it)", () => {
    for (const t of ORDER) expect(tierToParams(t).everyNthFrame).toBeGreaterThanOrEqual(1)
  })
})

describe("DEFAULT_TIER", () => {
  it("is balanced — latency over sharpness, no change for existing users", () => {
    expect(DEFAULT_TIER).toBe("balanced")
  })
})

describe("parseTier", () => {
  it("round-trips each valid tier id", () => {
    for (const t of ORDER) expect(parseTier(t)).toBe(t)
  })

  it("falls back to the default tier for null", () => {
    expect(parseTier(null)).toBe(DEFAULT_TIER)
  })

  it("falls back to the default tier for garbage", () => {
    expect(parseTier("turbo")).toBe(DEFAULT_TIER)
    expect(parseTier("")).toBe(DEFAULT_TIER)
    expect(parseTier("SHARP")).toBe(DEFAULT_TIER)
    expect(parseTier(undefined as unknown as string)).toBe(DEFAULT_TIER)
  })
})

describe("TIERS registry", () => {
  it("lists the three tiers in sharp → balanced → snappy order", () => {
    expect(TIERS.map((t) => t.id)).toEqual(ORDER)
  })

  it("every registry entry resolves through tierToParams", () => {
    for (const t of TIERS) expect(tierToParams(t.id)).toEqual(t.params)
  })
})
