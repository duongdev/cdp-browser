import { describe, expect, it } from "vitest"
import { type EchoState, initial, PRESS_FLASH_MS, reduce, view } from "./echo-cursor"

/** Drive a sequence of events through `reduce`, threading the running state. */
function run(events: { ev: Parameters<typeof reduce>[1]; now?: number }[], from = initial) {
  return events.reduce((s, { ev, now = 0 }) => reduce(s, ev, now), from as EchoState)
}

describe("echo-cursor — press state (write first)", () => {
  it("press lights an affordance at its position that auto-clears after PRESS_FLASH_MS", () => {
    const pressed = reduce(
      reduce(initial, { type: "enter" }, 0),
      { type: "press", pos: { x: 30, y: 40 } },
      1000,
    )

    // Active right after the press.
    expect(view(pressed, 1000).press).toEqual({ x: 30, y: 40, until: 1000 + PRESS_FLASH_MS })
    // Still active a hair before expiry.
    expect(view(pressed, 1000 + PRESS_FLASH_MS - 1).press).not.toBeNull()
    // Cleared once the flash window passes — driven by injected `now`, no real timer.
    expect(view(pressed, 1000 + PRESS_FLASH_MS).press).toBeNull()
  })

  it("a second press while one is active replaces it", () => {
    let s = reduce(initial, { type: "enter" }, 0)
    s = reduce(s, { type: "press", pos: { x: 1, y: 1 } }, 100)
    s = reduce(s, { type: "press", pos: { x: 9, y: 9 } }, 150)

    expect(view(s, 150).press).toEqual({ x: 9, y: 9, until: 150 + PRESS_FLASH_MS })
  })
})

describe("echo-cursor — position mapping", () => {
  it("move sets the cursor at the canvas-space point it was given", () => {
    const s = run([{ ev: { type: "enter" } }, { ev: { type: "move", pos: { x: 120, y: 240 } } }])
    expect(view(s, 0).pos).toEqual({ x: 120, y: 240 })
  })
})

describe("echo-cursor — show/hide", () => {
  it("enter shows on move, leave hides, and a move after leave does not re-show", () => {
    let s = run([{ ev: { type: "enter" } }, { ev: { type: "move", pos: { x: 5, y: 5 } } }])
    expect(view(s, 0).pos).toEqual({ x: 5, y: 5 })

    s = reduce(s, { type: "leave" }, 0)
    expect(view(s, 0).pos).toBeNull()

    // A move arriving after leave must not re-show until the next enter.
    s = reduce(s, { type: "move", pos: { x: 7, y: 7 } }, 0)
    expect(view(s, 0).pos).toBeNull()

    s = reduce(s, { type: "enter" }, 0)
    s = reduce(s, { type: "move", pos: { x: 8, y: 8 } }, 0)
    expect(view(s, 0).pos).toEqual({ x: 8, y: 8 })
  })

  it("disconnect hides the cursor and the press", () => {
    let s = run([
      { ev: { type: "enter" } },
      { ev: { type: "move", pos: { x: 5, y: 5 } } },
      { ev: { type: "press", pos: { x: 5, y: 5 } }, now: 0 },
    ])
    s = reduce(s, { type: "disconnect" }, 1)
    expect(view(s, 1)).toEqual({ pos: null, press: null })
  })
})

describe("echo-cursor — no-frame gate", () => {
  it("with hasFrame false the overlay is inert regardless of move/press", () => {
    let s = reduce(initial, { type: "enter" }, 0)
    s = reduce(s, { type: "frame-state", hasFrame: false }, 0)
    s = reduce(s, { type: "move", pos: { x: 10, y: 10 } }, 0)
    s = reduce(s, { type: "press", pos: { x: 10, y: 10 } }, 0)

    expect(view(s, 0)).toEqual({ pos: null, press: null })
  })

  it("regaining a frame lets the cursor show again on the next move", () => {
    let s = reduce(initial, { type: "enter" }, 0)
    s = reduce(s, { type: "frame-state", hasFrame: false }, 0)
    s = reduce(s, { type: "frame-state", hasFrame: true }, 0)
    s = reduce(s, { type: "move", pos: { x: 2, y: 3 } }, 0)

    expect(view(s, 0).pos).toEqual({ x: 2, y: 3 })
  })
})
