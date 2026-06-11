import { describe, expect, it } from "vitest"
import { keyDownAction, synthKey } from "./screencast-keys"

describe("synthKey", () => {
  it("carries the virtual key code the remote needs (the t084 delete bug)", () => {
    expect(synthKey("Backspace").keyCode).toBe(8)
    expect(synthKey("Enter").keyCode).toBe(13)
    expect(synthKey("ArrowLeft").keyCode).toBe(37)
    expect(synthKey("Tab").keyCode).toBe(9)
  })

  it("has no modifiers and mirrors key into code", () => {
    const k = synthKey("ArrowDown")
    expect(k).toMatchObject({ code: "ArrowDown", altKey: false, metaKey: false })
  })

  it("unknown keys get keyCode 0 (still inert, never throws)", () => {
    expect(synthKey("F13").keyCode).toBe(0)
  })
})

describe("keyDownAction", () => {
  it("forwards Backspace only when the field is empty (else the input delta deletes)", () => {
    expect(keyDownAction("Backspace", true)).toEqual({ type: "forward", key: "Backspace" })
    expect(keyDownAction("Backspace", false)).toEqual({ type: "ignore" })
  })

  it("forwards Enter / Tab / arrows / Escape regardless of field content", () => {
    for (const k of ["Enter", "Tab", "ArrowRight", "Escape"]) {
      expect(keyDownAction(k, false)).toEqual({ type: "forward", key: k })
    }
  })

  it("ignores printable keys (they ride the input delta)", () => {
    expect(keyDownAction("a", false)).toEqual({ type: "ignore" })
    expect(keyDownAction(" ", false)).toEqual({ type: "ignore" })
  })
})
