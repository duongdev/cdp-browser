import { describe, expect, it } from "vitest"
import { createTouchGesture, LONGPRESS_MS, MOVE_THRESHOLD_PX, TAP_WINDOW_MS } from "./touch-gesture"

describe("createTouchGesture — tap", () => {
  it("down then up under the movement threshold within the tap window is a tap at the down/up point", () => {
    const g = createTouchGesture()

    expect(g.down({ x: 100, y: 200, t: 0 })).toEqual([])
    const out = g.up({ x: 101, y: 201, t: 80 })

    expect(out).toEqual([{ type: "tap", x: 101, y: 201 }])
  })

  it("a perfectly still tap emits at the down coordinates", () => {
    const g = createTouchGesture()

    g.down({ x: 50, y: 60, t: 0 })
    const out = g.up({ x: 50, y: 60, t: 50 })

    expect(out).toEqual([{ type: "tap", x: 50, y: 60 }])
  })
})

describe("createTouchGesture — long-press", () => {
  it("holding past the long-press deadline with no movement emits a long-press at the down point", () => {
    const g = createTouchGesture()

    g.down({ x: 10, y: 20, t: 0 })
    expect(g.poll(LONGPRESS_MS - 1)).toEqual([])
    const out = g.poll(LONGPRESS_MS)

    expect(out).toEqual([{ type: "longpress", x: 10, y: 20 }])
  })

  it("fires the long-press only once even if polled again past the deadline", () => {
    const g = createTouchGesture()

    g.down({ x: 10, y: 20, t: 0 })
    g.poll(LONGPRESS_MS)
    const again = g.poll(LONGPRESS_MS + 100)

    expect(again).toEqual([])
  })

  it("after a long-press fires, a later up does not also emit a tap", () => {
    const g = createTouchGesture()

    g.down({ x: 10, y: 20, t: 0 })
    g.poll(LONGPRESS_MS)
    const out = g.up({ x: 10, y: 20, t: LONGPRESS_MS + 50 })

    expect(out).toEqual([])
  })
})

describe("createTouchGesture — drag → scroll", () => {
  it("moving past the movement threshold classifies as a drag and emits scroll deltas", () => {
    const g = createTouchGesture()

    g.down({ x: 100, y: 100, t: 0 })
    const out = g.move({ x: 100, y: 100 - (MOVE_THRESHOLD_PX + 5), t: 30 })

    expect(out).toHaveLength(1)
    expect(out[0].type).toBe("scroll")
  })

  it("dragging the finger DOWN scrolls content down (negative deltaY — natural scroll)", () => {
    const g = createTouchGesture()

    g.down({ x: 100, y: 100, t: 0 })
    // finger moves down by more than the threshold
    const out = g.move({ x: 100, y: 100 + MOVE_THRESHOLD_PX + 10, t: 30 })

    expect(out[0]).toMatchObject({ type: "scroll", x: 100 })
    if (out[0].type === "scroll") expect(out[0].deltaY).toBeLessThan(0)
  })

  it("dragging the finger UP scrolls content up (positive deltaY)", () => {
    const g = createTouchGesture()

    g.down({ x: 100, y: 100, t: 0 })
    const out = g.move({ x: 100, y: 100 - (MOVE_THRESHOLD_PX + 10), t: 30 })

    if (out[0].type === "scroll") expect(out[0].deltaY).toBeGreaterThan(0)
  })

  it("dragging the finger LEFT scrolls content left (positive deltaX — natural scroll)", () => {
    const g = createTouchGesture()

    g.down({ x: 100, y: 100, t: 0 })
    const out = g.move({ x: 100 - (MOVE_THRESHOLD_PX + 10), y: 100, t: 30 })

    if (out[0].type === "scroll") expect(out[0].deltaX).toBeGreaterThan(0)
  })

  it("accumulates per-step deltas relative to the previous sample, not the down point", () => {
    const g = createTouchGesture()

    g.down({ x: 100, y: 100, t: 0 })
    g.move({ x: 100, y: 130, t: 30 }) // commits to drag (down by 30)
    const out = g.move({ x: 100, y: 140, t: 60 }) // a further 10 down

    // second step is only the 10px delta since the previous sample
    if (out[0].type === "scroll") expect(out[0].deltaY).toBe(-10)
  })

  it("anchors each scroll event at the current finger point", () => {
    const g = createTouchGesture()

    g.down({ x: 100, y: 100, t: 0 })
    const out = g.move({ x: 140, y: 100 + MOVE_THRESHOLD_PX + 10, t: 30 })

    expect(out[0]).toMatchObject({ x: 140 })
  })
})

describe("createTouchGesture — drag is sticky", () => {
  it("once a drag, a later up never emits a tap even if the finger ends near the start", () => {
    const g = createTouchGesture()

    g.down({ x: 100, y: 100, t: 0 })
    g.move({ x: 100, y: 100 + MOVE_THRESHOLD_PX + 10, t: 30 })
    g.move({ x: 100, y: 100, t: 60 }) // back near the origin
    const out = g.up({ x: 100, y: 100, t: 90 })

    expect(out).toEqual([])
  })

  it("once a drag, polling past the long-press deadline never emits a long-press", () => {
    const g = createTouchGesture()

    g.down({ x: 100, y: 100, t: 0 })
    g.move({ x: 100, y: 100 + MOVE_THRESHOLD_PX + 10, t: 30 })
    const out = g.poll(LONGPRESS_MS + 100)

    expect(out).toEqual([])
  })
})

describe("createTouchGesture — jitter tolerance", () => {
  it("movement just under the threshold during the hold still allows long-press", () => {
    const g = createTouchGesture()

    g.down({ x: 100, y: 100, t: 0 })
    expect(g.move({ x: 100 + (MOVE_THRESHOLD_PX - 1), y: 100, t: 20 })).toEqual([])
    const out = g.poll(LONGPRESS_MS)

    expect(out).toEqual([{ type: "longpress", x: 100, y: 100 }])
  })

  it("movement just under the threshold then an up still classifies as a tap", () => {
    const g = createTouchGesture()

    g.down({ x: 100, y: 100, t: 0 })
    g.move({ x: 100 + (MOVE_THRESHOLD_PX - 1), y: 100, t: 20 })
    const out = g.up({ x: 100 + (MOVE_THRESHOLD_PX - 1), y: 100, t: 60 })

    expect(out).toEqual([{ type: "tap", x: 100 + (MOVE_THRESHOLD_PX - 1), y: 100 }])
  })

  it("movement just over the threshold cancels long-press into a drag", () => {
    const g = createTouchGesture()

    g.down({ x: 100, y: 100, t: 0 })
    const moved = g.move({ x: 100 + (MOVE_THRESHOLD_PX + 1), y: 100, t: 20 })
    const polled = g.poll(LONGPRESS_MS)

    expect(moved[0].type).toBe("scroll")
    expect(polled).toEqual([])
  })
})

describe("createTouchGesture — boundaries", () => {
  it("movement exactly at the threshold does NOT yet commit to a drag (drag needs to exceed it)", () => {
    const g = createTouchGesture()

    g.down({ x: 100, y: 100, t: 0 })
    const moved = g.move({ x: 100 + MOVE_THRESHOLD_PX, y: 100, t: 20 })
    // still a candidate tap/long-press, so an up resolves to a tap
    const up = g.up({ x: 100 + MOVE_THRESHOLD_PX, y: 100, t: 40 })

    expect(moved).toEqual([])
    expect(up).toEqual([{ type: "tap", x: 100 + MOVE_THRESHOLD_PX, y: 100 }])
  })

  it("an up exactly at the tap window still counts as a tap (window is inclusive)", () => {
    const g = createTouchGesture()

    g.down({ x: 100, y: 100, t: 0 })
    const out = g.up({ x: 100, y: 100, t: TAP_WINDOW_MS })

    expect(out).toEqual([{ type: "tap", x: 100, y: 100 }])
  })

  it("an up past the tap window (but no long-press fired, no movement) emits nothing", () => {
    const g = createTouchGesture()

    g.down({ x: 100, y: 100, t: 0 })
    const out = g.up({ x: 100, y: 100, t: TAP_WINDOW_MS + 1 })

    expect(out).toEqual([])
  })

  it("poll exactly at the long-press deadline fires (deadline is inclusive)", () => {
    const g = createTouchGesture()

    g.down({ x: 100, y: 100, t: 0 })
    const out = g.poll(LONGPRESS_MS)

    expect(out).toEqual([{ type: "longpress", x: 100, y: 100 }])
  })
})

describe("createTouchGesture — cancel", () => {
  it("a cancelled gesture emits nothing on a later up (the OS stole it)", () => {
    const g = createTouchGesture()

    g.down({ x: 100, y: 100, t: 0 })
    g.cancel()
    const out = g.up({ x: 100, y: 100, t: 40 })

    expect(out).toEqual([])
  })

  it("a cancelled gesture stops emitting scroll on later moves", () => {
    const g = createTouchGesture()

    g.down({ x: 100, y: 100, t: 0 })
    g.cancel()
    const out = g.move({ x: 100, y: 200, t: 40 })

    expect(out).toEqual([])
  })
})
