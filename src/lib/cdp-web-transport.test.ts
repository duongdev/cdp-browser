import { describe, expect, it } from "vitest"
import { collapseMoves } from "./cdp-web-transport"

const move = (x: number) => ({
  method: "Input.dispatchMouseEvent",
  params: { type: "mouseMoved", x },
})
const click = () => ({ method: "Input.dispatchMouseEvent", params: { type: "mousePressed" } })
const wheel = (dy: number) => ({
  method: "Input.dispatchMouseEvent",
  params: { type: "mouseWheel", dy },
})
const key = () => ({ method: "Input.dispatchKeyEvent", params: { type: "keyDown" } })

describe("collapseMoves", () => {
  it("collapses a run of consecutive mouseMoved to the latest", () => {
    expect(collapseMoves([move(1), move(2), move(3)])).toEqual([move(3)])
  })

  it("a click breaks a run, preserving order and both surrounding positions", () => {
    expect(collapseMoves([move(1), move(2), click(), move(3), move(4)])).toEqual([
      move(2),
      click(),
      move(4),
    ])
  })

  it("preserves wheel and key events (only mouseMoved collapses)", () => {
    expect(collapseMoves([wheel(10), wheel(20), key()])).toEqual([wheel(10), wheel(20), key()])
  })

  it("leaves a single move untouched", () => {
    expect(collapseMoves([move(5)])).toEqual([move(5)])
  })
})
