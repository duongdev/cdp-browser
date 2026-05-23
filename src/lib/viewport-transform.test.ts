import { describe, expect, it } from "vitest"
import { letterbox, modifiers, toRemoteCoords } from "./viewport-transform"

describe("letterbox", () => {
  it("centers a wide frame inside a square canvas with vertical offset", () => {
    // 2:1 frame in a 1:1 canvas -> scale limited by width, black bars top/bottom
    const { scale, dx, dy } = letterbox({ w: 1000, h: 500 }, { w: 1000, h: 1000 })
    expect(scale).toBe(1)
    expect(dx).toBe(0)
    expect(dy).toBe(250)
  })

  it("centers a tall frame inside a wide canvas with horizontal offset", () => {
    // 1:2 frame in a 2:1 canvas -> scale limited by height, black bars left/right
    const { scale, dx, dy } = letterbox({ w: 500, h: 1000 }, { w: 2000, h: 1000 })
    expect(scale).toBe(1)
    expect(dx).toBe(750)
    expect(dy).toBe(0)
  })
})

describe("toRemoteCoords", () => {
  const rect = { left: 0, top: 0, width: 1000, height: 1000 }

  it("maps the canvas center to the frame center, skipping the letterbox bars", () => {
    // frame 1000x500 in 1000x1000 canvas -> 250px bars top/bottom
    const p = toRemoteCoords({ x: 500, y: 500 }, rect, 1, { w: 1000, h: 500 })
    expect(p).toEqual({ x: 500, y: 250 })
  })

  it("accounts for device pixel ratio and canvas offset", () => {
    const offset = { left: 100, top: 50, width: 1000, height: 1000 }
    // dpr 2 doubles canvas pixels; frame matches aspect so no bars
    const p = toRemoteCoords({ x: 600, y: 550 }, offset, 2, { w: 2000, h: 2000 })
    expect(p).toEqual({ x: 1000, y: 1000 })
  })
})

describe("modifiers", () => {
  const none = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false }

  it("is zero when no modifier is held", () => {
    expect(modifiers(none)).toBe(0)
  })

  it("encodes alt=1, ctrl=2, meta=4, shift=8 as a CDP bitmask", () => {
    expect(modifiers({ ...none, altKey: true })).toBe(1)
    expect(modifiers({ ...none, ctrlKey: true })).toBe(2)
    expect(modifiers({ ...none, metaKey: true })).toBe(4)
    expect(modifiers({ ...none, shiftKey: true })).toBe(8)
    expect(modifiers({ altKey: true, ctrlKey: false, metaKey: true, shiftKey: true })).toBe(13)
  })
})
