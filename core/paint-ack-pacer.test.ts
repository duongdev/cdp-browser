import { describe, expect, it } from "vitest"
// CommonJS shared core (ADR-0008): adaptive paint-ack watchdog window.
import { createPaintAckPacer } from "./paint-ack-pacer"

describe("createPaintAckPacer", () => {
  it("returns the floor before any sample", () => {
    expect(createPaintAckPacer().windowMs()).toBe(1000)
  })

  it("stays at the floor for fast paints", () => {
    const p = createPaintAckPacer()
    p.record(50)
    expect(p.windowMs()).toBe(1000) // 3 * 50 < floor
  })

  it("grows to a multiple of the EWMA for slow paints", () => {
    const p = createPaintAckPacer({ alpha: 1 }) // alpha 1 → EWMA tracks the last sample
    p.record(500)
    expect(p.windowMs()).toBe(1500) // 3 * 500
  })

  it("caps the window for pathologically slow paints", () => {
    const p = createPaintAckPacer({ alpha: 1 })
    p.record(10_000)
    expect(p.windowMs()).toBe(5000)
  })

  it("smooths samples via the EWMA", () => {
    const p = createPaintAckPacer({ alpha: 0.5, floorMs: 0 })
    p.record(1000) // EWMA = 1000
    p.record(2000) // EWMA = 0.5*2000 + 0.5*1000 = 1500
    expect(p.windowMs()).toBe(4500) // 3 * 1500
  })

  it("ignores negative / NaN latencies", () => {
    const p = createPaintAckPacer({ alpha: 1 })
    p.record(600) // window 1800
    p.record(-5)
    p.record(Number.NaN)
    expect(p.windowMs()).toBe(1800)
  })
})
