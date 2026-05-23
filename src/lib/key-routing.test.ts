import { describe, expect, it } from "vitest"
import { isOsReservedKey } from "./key-routing"

const base = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, code: "" }

describe("isOsReservedKey", () => {
  it("reserves macOS app/window combos for native handling", () => {
    expect(isOsReservedKey({ ...base, metaKey: true, code: "KeyH" })).toBe(true) // hide
    expect(isOsReservedKey({ ...base, metaKey: true, altKey: true, code: "KeyH" })).toBe(true) // hide others
    expect(isOsReservedKey({ ...base, metaKey: true, code: "KeyM" })).toBe(true) // minimize
    expect(isOsReservedKey({ ...base, metaKey: true, code: "KeyQ" })).toBe(true) // quit
    expect(isOsReservedKey({ ...base, metaKey: true, code: "Backquote" })).toBe(true) // cycle windows
    expect(isOsReservedKey({ ...base, metaKey: true, shiftKey: true, code: "Backquote" })).toBe(
      true,
    )
    expect(isOsReservedKey({ ...base, metaKey: true, ctrlKey: true, code: "KeyF" })).toBe(true) // fullscreen
  })

  it("matches on physical code, unaffected by Option rewriting the character", () => {
    // Cmd+Opt+H reports key "˙" but code stays "KeyH".
    expect(isOsReservedKey({ ...base, metaKey: true, altKey: true, code: "KeyH" })).toBe(true)
  })

  it("never reserves keys without Cmd — remote page owns them", () => {
    expect(isOsReservedKey({ ...base, code: "KeyH" })).toBe(false)
    expect(isOsReservedKey({ ...base, ctrlKey: true, code: "KeyF" })).toBe(false)
    expect(isOsReservedKey({ ...base, altKey: true, code: "KeyH" })).toBe(false)
  })

  it("leaves content/editing combos to the remote page", () => {
    for (const code of ["KeyC", "KeyV", "KeyX", "KeyZ", "KeyA", "KeyR", "KeyT", "KeyW", "KeyL"]) {
      expect(isOsReservedKey({ ...base, metaKey: true, code })).toBe(false)
    }
    // Bare Cmd+F (in-page find) stays with the app/page; only Ctrl+Cmd+F is reserved.
    expect(isOsReservedKey({ ...base, metaKey: true, code: "KeyF" })).toBe(false)
    expect(isOsReservedKey({ ...base, metaKey: true, altKey: true, code: "KeyL" })).toBe(false)
  })
})
