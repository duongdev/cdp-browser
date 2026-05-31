import { describe, expect, it } from "vitest"
// CommonJS module shared with main.js (which can't import src/lib ESM).
import { emulatedMediaParams } from "./theme-emulation"

describe("emulatedMediaParams", () => {
  it("emulates dark prefers-color-scheme when syncing and the app is dark", () => {
    expect(emulatedMediaParams(true, true)).toEqual({
      features: [{ name: "prefers-color-scheme", value: "dark" }],
    })
  })

  it("emulates light prefers-color-scheme when syncing and the app is light", () => {
    expect(emulatedMediaParams(true, false)).toEqual({
      features: [{ name: "prefers-color-scheme", value: "light" }],
    })
  })

  it("resets emulation with empty params when sync is off, regardless of app theme", () => {
    expect(emulatedMediaParams(false, true)).toEqual({})
    expect(emulatedMediaParams(false, false)).toEqual({})
  })
})
