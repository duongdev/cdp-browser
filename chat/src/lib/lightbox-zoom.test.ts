import { describe, expect, it } from "vitest"
import { IDENTITY, isZoomed, panBy, zoomAround } from "./lightbox-zoom"

const VP = { w: 200, h: 100 }

describe("zoomAround", () => {
  it("zooms in around a pivot and keeps the pivot fixed", () => {
    const z = zoomAround(IDENTITY, { x: 100, y: 50 }, 2, VP)
    expect(z.scale).toBe(2)
    // pivot maps to itself: pivot·scale + offset === pivot
    expect(100 * z.scale + z.x).toBeCloseTo(100, 5)
    expect(z.x).toBeCloseTo(-100, 5)
    expect(z.y).toBeCloseTo(-50, 5)
  })

  it("snaps back to fit at scale 1", () => {
    const z = zoomAround({ scale: 2, x: -100, y: -50 }, { x: 100, y: 50 }, 1, VP)
    expect(z).toEqual(IDENTITY)
  })

  it("clamps scale to MAX", () => {
    const z = zoomAround(IDENTITY, { x: 0, y: 0 }, 999, VP)
    expect(z.scale).toBe(4)
  })
})

describe("panBy", () => {
  it("is a no-op at fit (1×)", () => {
    expect(panBy(IDENTITY, 30, 30, VP)).toBe(IDENTITY)
  })

  it("pans within bounds and clamps so content covers the viewport", () => {
    const z = zoomAround(IDENTITY, { x: 100, y: 50 }, 2, VP) // x=-100,y=-50
    const panned = panBy(z, 40, 40, VP)
    // offset can't go positive (would reveal a void) — clamped at 0
    expect(panned.x).toBeLessThanOrEqual(0)
    expect(panned.y).toBeLessThanOrEqual(0)
    expect(isZoomed(panned)).toBe(true)
  })
})
