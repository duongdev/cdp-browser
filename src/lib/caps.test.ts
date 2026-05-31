import { describe, expect, it } from "vitest"
import { DEFAULT_CAPS, getCaps } from "./caps"

describe("getCaps", () => {
  it("returns the injected web caps when present (web build: localTabs off)", () => {
    const caps = getCaps(() => ({ web: true, localTabs: false, extensions: false }))

    expect(caps).toEqual({ web: true, localTabs: false, extensions: false })
  })

  it("returns the Electron default (full capability) when webCaps is absent", () => {
    const caps = getCaps(() => undefined)

    expect(caps).toEqual({ web: false, localTabs: true, extensions: true })
  })

  it("DEFAULT_CAPS is the restricted web set the shim installs", () => {
    expect(DEFAULT_CAPS).toEqual({ web: true, localTabs: false, extensions: false })
  })
})
