import { describe, expect, it } from "vitest"
import {
  applyPinch,
  clampToViewport,
  IDENTITY,
  isZoomed,
  MAX_SCALE,
  toFitPoint,
} from "./canvas-zoom"

const vp = { w: 400, h: 800 }

describe("applyPinch", () => {
  it("doubling finger distance around the center doubles the scale", () => {
    const prev: [{ x: number; y: number }, { x: number; y: number }] = [
      { x: 150, y: 400 },
      { x: 250, y: 400 },
    ]
    const cur: [{ x: number; y: number }, { x: number; y: number }] = [
      { x: 100, y: 400 },
      { x: 300, y: 400 },
    ]
    const s = applyPinch(IDENTITY, prev, cur, vp)
    expect(s.scale).toBeCloseTo(2)
  })

  it("keeps the pinch anchor visually fixed (the zoom-around-point invariant)", () => {
    const prev: [{ x: number; y: number }, { x: number; y: number }] = [
      { x: 100, y: 300 },
      { x: 200, y: 300 },
    ]
    const cur: [{ x: number; y: number }, { x: number; y: number }] = [
      { x: 80, y: 300 },
      { x: 220, y: 300 },
    ]
    const mid = { x: 150, y: 300 }
    const before = toFitPoint(IDENTITY, mid)
    const s = applyPinch(IDENTITY, prev, cur, vp)
    const after = toFitPoint(s, mid)
    expect(after.x).toBeCloseTo(before.x, 5)
    expect(after.y).toBeCloseTo(before.y, 5)
  })

  it("clamps the scale to MAX_SCALE", () => {
    let s = IDENTITY
    const prev: [{ x: number; y: number }, { x: number; y: number }] = [
      { x: 190, y: 400 },
      { x: 210, y: 400 },
    ]
    const cur: [{ x: number; y: number }, { x: number; y: number }] = [
      { x: 0, y: 400 },
      { x: 400, y: 400 },
    ]
    s = applyPinch(s, prev, cur, vp)
    s = applyPinch(s, prev, cur, vp)
    expect(s.scale).toBe(MAX_SCALE)
  })

  it("pinching out below 1x snaps back to identity (the reset affordance)", () => {
    const zoomed = { scale: 1.2, x: -40, y: -80 }
    const prev: [{ x: number; y: number }, { x: number; y: number }] = [
      { x: 100, y: 400 },
      { x: 300, y: 400 },
    ]
    const cur: [{ x: number; y: number }, { x: number; y: number }] = [
      { x: 180, y: 400 },
      { x: 220, y: 400 },
    ]
    expect(applyPinch(zoomed, prev, cur, vp)).toEqual(IDENTITY)
  })

  it("two-finger drag (same distance) pans, clamped to the viewport", () => {
    const zoomed = clampToViewport({ scale: 2, x: -200, y: -400 }, vp)
    const prev: [{ x: number; y: number }, { x: number; y: number }] = [
      { x: 100, y: 400 },
      { x: 200, y: 400 },
    ]
    const cur: [{ x: number; y: number }, { x: number; y: number }] = [
      { x: 130, y: 380 },
      { x: 230, y: 380 },
    ]
    const s = applyPinch(zoomed, prev, cur, vp)
    expect(s.scale).toBeCloseTo(2)
    expect(s.x).toBeCloseTo(-170)
    expect(s.y).toBeCloseTo(-420)
  })
})

describe("clampToViewport", () => {
  it("never exposes space beyond the content edges", () => {
    expect(clampToViewport({ scale: 2, x: 50, y: -2000 }, vp)).toEqual({
      scale: 2,
      x: 0,
      y: -800,
    })
  })

  it("identity passes through untouched", () => {
    expect(clampToViewport(IDENTITY, vp)).toEqual(IDENTITY)
  })
})

describe("toFitPoint / isZoomed", () => {
  it("is the identity mapping at 1x", () => {
    expect(toFitPoint(IDENTITY, { x: 33, y: 44 })).toEqual({ x: 33, y: 44 })
    expect(isZoomed(IDENTITY)).toBe(false)
  })

  it("inverts the zoom transform", () => {
    const s = { scale: 2, x: -100, y: -50 }
    expect(toFitPoint(s, { x: 100, y: 150 })).toEqual({ x: 100, y: 100 })
    expect(isZoomed(s)).toBe(true)
  })
})
