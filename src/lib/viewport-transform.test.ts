import { describe, expect, it } from "vitest"
import { drawFrame, letterbox, modifiers, toRemoteCoords } from "./viewport-transform"

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

  it("scales image px to remote DIP when the frame is downscaled", () => {
    // frame 1000x1000 fills the canvas, but the remote layout viewport is 2000x2000 DIP
    // (the screencast was capped below the remote size) -> a center click maps to 1000,1000
    const p = toRemoteCoords(
      { x: 500, y: 500 },
      rect,
      1,
      { w: 1000, h: 1000 },
      { w: 2000, h: 2000 },
    )
    expect(p).toEqual({ x: 1000, y: 1000 })
  })

  it("is identity when the device size equals the frame size (no downscale)", () => {
    const p = toRemoteCoords(
      { x: 300, y: 700 },
      rect,
      1,
      { w: 1000, h: 1000 },
      { w: 1000, h: 1000 },
    )
    expect(p).toEqual({ x: 300, y: 700 })
  })

  it("subtracts the metadata offsetTop on the y axis", () => {
    const p = toRemoteCoords(
      { x: 0, y: 500 },
      rect,
      1,
      { w: 1000, h: 1000 },
      { w: 1000, h: 1000 },
      40,
    )
    expect(p).toEqual({ x: 0, y: 460 })
  })
})

describe("drawFrame", () => {
  it("fills the whole canvas and centers a frame that matches the canvas aspect (no bars)", () => {
    const layout = drawFrame({ w: 1000, h: 1000 }, { w: 1000, h: 1000 })
    expect(layout.canvas).toEqual({ w: 1000, h: 1000 })
    expect(layout.box).toEqual({ scale: 1, dx: 0, dy: 0 })
    expect(layout.fill).toEqual({ left: 0, top: 0, width: 1000, height: 1000 })
    expect(layout.dest).toEqual({ x: 0, y: 0, w: 1000, h: 1000 })
  })

  it("leaves top/bottom bars for a wider-than-canvas frame", () => {
    // 2:1 frame in a 1:1 canvas -> scaled to width, bars top/bottom
    const layout = drawFrame({ w: 1000, h: 1000 }, { w: 1000, h: 500 })
    expect(layout.box).toEqual({ scale: 1, dx: 0, dy: 250 })
    expect(layout.fill).toEqual({ left: 0, top: 0, width: 1000, height: 1000 })
    expect(layout.dest).toEqual({ x: 0, y: 250, w: 1000, h: 500 })
  })

  it("leaves left/right bars for a taller-than-canvas frame", () => {
    // 1:2 frame in a 2:1 canvas -> scaled to height, bars left/right
    const layout = drawFrame({ w: 2000, h: 1000 }, { w: 500, h: 1000 })
    expect(layout.box).toEqual({ scale: 1, dx: 750, dy: 0 })
    expect(layout.fill).toEqual({ left: 0, top: 0, width: 2000, height: 1000 })
    expect(layout.dest).toEqual({ x: 750, y: 0, w: 500, h: 1000 })
  })

  it("drives drawImage placement with image px (not device DIP) on a downscaled frame", () => {
    // The frame arrives at 1000x1000 image px even though the remote layout viewport is
    // 2000x2000 DIP. drawImage must place the actual image px, filling the same canvas
    // region a non-downscaled frame would.
    const layout = drawFrame({ w: 1000, h: 1000 }, { w: 1000, h: 1000 })
    expect(layout.dest).toEqual({ x: 0, y: 0, w: 1000, h: 1000 })
  })

  it("scales a frame up to fill the canvas when the canvas is larger", () => {
    const layout = drawFrame({ w: 2000, h: 1000 }, { w: 1000, h: 500 })
    expect(layout.box).toEqual({ scale: 2, dx: 0, dy: 0 })
    expect(layout.dest).toEqual({ x: 0, y: 0, w: 2000, h: 1000 })
  })
})

describe("drawFrame / toRemoteCoords agreement (divergence-proof)", () => {
  // A point drawn at canvas position P must map back through toRemoteCoords to the remote
  // DIP that drawFrame placed under P. Modeled on one frame-view snapshot, so the draw
  // path and the hit-test can never reason about different frame dimensions.
  //
  // Downscaled + letterboxed: a 800x400 image-px frame from a 1600x800 DIP remote viewport
  // (uniform 2x downscale — the screencast preserves aspect), painted into a 1000x1000
  // device-px canvas. dpr 1 (rect == canvas), offsetTop 0.
  const frame = { w: 800, h: 400 }
  const device = { w: 1600, h: 800 }
  const canvas = { w: 1000, h: 1000 }
  const rect = { left: 0, top: 0, width: canvas.w, height: canvas.h }
  const dpr = 1
  const layout = drawFrame(canvas, frame)

  // Invert drawFrame's placement: a remote DIP -> the canvas client point under it.
  const dipToCanvas = (dipX: number, dipY: number) => {
    // remote DIP -> image px -> scaled+offset canvas px (== client px at dpr 1)
    const imgX = (dipX / device.w) * frame.w
    const imgY = (dipY / device.h) * frame.h
    return {
      x: rect.left + layout.dest.x + imgX * layout.box.scale,
      y: rect.top + layout.dest.y + imgY * layout.box.scale,
    }
  }

  const corners: Array<[string, number, number]> = [
    ["top-left", 0, 0],
    ["top-right", device.w, 0],
    ["bottom-left", 0, device.h],
    ["bottom-right", device.w, device.h],
    ["center", device.w / 2, device.h / 2],
  ]

  for (const [name, dipX, dipY] of corners) {
    it(`round-trips the ${name} of the frame within rounding`, () => {
      const p = dipToCanvas(dipX, dipY)
      const back = toRemoteCoords(p, rect, dpr, frame, device, 0)
      expect(back.x).toBe(Math.round(dipX))
      expect(back.y).toBe(Math.round(dipY))
    })
  }
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
