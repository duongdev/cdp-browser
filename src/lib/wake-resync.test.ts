import { describe, expect, it } from "vitest"
import { shouldResyncOnWake } from "./wake-resync"

describe("shouldResyncOnWake", () => {
  it("resyncs when the tab is foregrounded, WS is believed up, but the probe saw no server signal", () => {
    expect(shouldResyncOnWake({ visible: true, wsUp: true, sawSignalDuringProbe: false })).toBe(
      true,
    )
  })

  it("does not resync when a server signal arrived during the probe (connection is alive)", () => {
    expect(shouldResyncOnWake({ visible: true, wsUp: true, sawSignalDuringProbe: true })).toBe(
      false,
    )
  })

  it("does not resync while hidden", () => {
    expect(shouldResyncOnWake({ visible: false, wsUp: true, sawSignalDuringProbe: false })).toBe(
      false,
    )
  })

  it("does not resync when WS is already known down (the re-climb loop owns that)", () => {
    expect(shouldResyncOnWake({ visible: true, wsUp: false, sawSignalDuringProbe: false })).toBe(
      false,
    )
  })
})
