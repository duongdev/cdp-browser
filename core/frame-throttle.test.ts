import { describe, expect, it } from "vitest"
// CommonJS shared core — consumed by web/server.mjs (and reused by t055 to map a
// quality tier → target FPS). DI clock keeps the rate decision unit-testable.
import { createFrameThrottle, everyNthFrameFor } from "./frame-throttle"

// A fake clock: `now()` reads `t`, tests advance it by mutating the closure.
function fakeClock() {
  let t = 0
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

describe("createFrameThrottle", () => {
  it("emits the first frame", () => {
    const clock = fakeClock()
    const throttle = createFrameThrottle({ targetFps: 30, now: clock.now })
    expect(throttle.shouldEmit()).toBe(true)
  })

  it("suppresses a frame arriving before the interval since the last emit", () => {
    const clock = fakeClock()
    const throttle = createFrameThrottle({ targetFps: 20, now: clock.now }) // 50ms interval
    expect(throttle.shouldEmit()).toBe(true)
    clock.advance(10)
    expect(throttle.shouldEmit()).toBe(false)
    clock.advance(20) // 30ms total < 50ms
    expect(throttle.shouldEmit()).toBe(false)
  })

  it("emits and resets the window after the interval elapses", () => {
    const clock = fakeClock()
    const throttle = createFrameThrottle({ targetFps: 20, now: clock.now }) // 50ms interval
    expect(throttle.shouldEmit()).toBe(true)
    clock.advance(50)
    expect(throttle.shouldEmit()).toBe(true)
    clock.advance(10)
    expect(throttle.shouldEmit()).toBe(false)
    clock.advance(40)
    expect(throttle.shouldEmit()).toBe(true)
  })

  it("emits exactly one frame from a burst within one interval (the freshest)", () => {
    const clock = fakeClock()
    const throttle = createFrameThrottle({ targetFps: 10, now: clock.now }) // 100ms interval
    let emitted = 0
    // First frame opens the window.
    if (throttle.shouldEmit()) emitted++
    // 9 more frames all inside the same 100ms window — all dropped.
    for (let i = 0; i < 9; i++) {
      clock.advance(5)
      if (throttle.shouldEmit()) emitted++
    }
    expect(emitted).toBe(1)
  })

  it("does not throttle when targetFps is 0", () => {
    const clock = fakeClock()
    const throttle = createFrameThrottle({ targetFps: 0, now: clock.now })
    expect(throttle.shouldEmit()).toBe(true)
    expect(throttle.shouldEmit()).toBe(true)
    expect(throttle.shouldEmit()).toBe(true)
  })

  it("does not throttle when targetFps is unset", () => {
    const clock = fakeClock()
    const throttle = createFrameThrottle({ now: clock.now })
    expect(throttle.shouldEmit()).toBe(true)
    expect(throttle.shouldEmit()).toBe(true)
  })

  it("does not throttle when targetFps is Infinity", () => {
    const clock = fakeClock()
    const throttle = createFrameThrottle({ targetFps: Number.POSITIVE_INFINITY, now: clock.now })
    expect(throttle.shouldEmit()).toBe(true)
    expect(throttle.shouldEmit()).toBe(true)
  })

  it("defaults the clock to Date.now when not injected", () => {
    const throttle = createFrameThrottle({ targetFps: 1 })
    expect(throttle.shouldEmit()).toBe(true) // first always emits, no clock needed
  })
})

describe("everyNthFrameFor", () => {
  it("floors a 60fps source to the target fps", () => {
    expect(everyNthFrameFor(20, 60)).toBe(3) // 60 / 20
    expect(everyNthFrameFor(30, 60)).toBe(2)
  })

  it("clamps to at least 1 (never 0 — Chromium rejects 0)", () => {
    expect(everyNthFrameFor(60, 60)).toBe(1)
    expect(everyNthFrameFor(120, 60)).toBe(1) // target above source
  })

  it("returns 1 when targetFps is falsy (no producer-side cap)", () => {
    expect(everyNthFrameFor(0, 60)).toBe(1)
    expect(everyNthFrameFor(undefined, 60)).toBe(1)
  })
})
