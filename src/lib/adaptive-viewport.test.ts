import { describe, expect, it } from "vitest"
import { deviceMetrics, initial, reduce } from "./adaptive-viewport"

const bounds = (width: number, height: number) => ({ width, height })
const resize = (w: number, h: number, b: { width: number; height: number }) =>
  ({ type: "resize", canvas: { w, h }, bounds: b }) as const

describe("deviceMetrics", () => {
  it("maps canvas CSS size to CDP override params at deviceScaleFactor 1", () => {
    expect(deviceMetrics({ w: 1280, h: 720 })).toEqual({
      width: 1280,
      height: 720,
      deviceScaleFactor: 1,
      mobile: false,
    })
  })

  it("rounds fractional canvas dimensions", () => {
    expect(deviceMetrics({ w: 800.6, h: 599.4 })).toEqual({
      width: 801,
      height: 599,
      deviceScaleFactor: 1,
      mobile: false,
    })
  })
})

describe("adaptive reducer", () => {
  it("applies an override and stores the baseline on resize while enabled", () => {
    const enabled = reduce(initial, { type: "enable" }).state
    const { state, effects } = reduce(enabled, resize(1280, 720, bounds(1500, 900)))
    expect(effects).toEqual([
      { type: "applyOverride", metrics: deviceMetrics({ w: 1280, h: 720 }) },
    ])
    expect(state.baseline).toEqual(bounds(1500, 900))
  })

  it("emits nothing on resize while disabled", () => {
    const { effects } = reduce(initial, resize(1280, 720, bounds(1500, 900)))
    expect(effects).toEqual([])
  })

  it("backs off when the host window drifts beyond the threshold", () => {
    const active = reduce(
      reduce(initial, { type: "enable" }).state,
      resize(1280, 720, bounds(1500, 900)),
    ).state
    const { state, effects } = reduce(active, { type: "poll", bounds: bounds(1500, 950) })
    expect(effects).toEqual([{ type: "clearOverride" }])
    expect(state.dormant).toBe(true)
  })

  it("stays active when host bounds wobble within the threshold", () => {
    const active = reduce(
      reduce(initial, { type: "enable" }).state,
      resize(1280, 720, bounds(1500, 900)),
    ).state
    const { state, effects } = reduce(active, { type: "poll", bounds: bounds(1502, 898) })
    expect(effects).toEqual([])
    expect(state.dormant).toBe(false)
  })

  it("ignores resize and poll while dormant", () => {
    const dormant: typeof initial = { enabled: true, dormant: true, baseline: null }
    expect(reduce(dormant, resize(1280, 720, bounds(1500, 900))).effects).toEqual([])
    expect(reduce(dormant, { type: "poll", bounds: bounds(9999, 9999) }).effects).toEqual([])
  })

  it("clears the override and resets when disabled while active", () => {
    const active = reduce(
      reduce(initial, { type: "enable" }).state,
      resize(1280, 720, bounds(1500, 900)),
    ).state
    const { state, effects } = reduce(active, { type: "disable" })
    expect(effects).toEqual([{ type: "clearOverride" }])
    expect(state).toEqual(initial)
  })

  it("emits nothing when disabling while already off", () => {
    expect(reduce(initial, { type: "disable" }).effects).toEqual([])
  })

  it("re-arms on enable after going dormant", () => {
    const dormant: typeof initial = { enabled: true, dormant: true, baseline: null }
    const rearmed = reduce(dormant, { type: "enable" }).state
    const { effects } = reduce(rearmed, resize(1280, 720, bounds(1500, 900)))
    expect(effects).toEqual([
      { type: "applyOverride", metrics: deviceMetrics({ w: 1280, h: 720 }) },
    ])
  })

  it("re-anchors the baseline on rebaseline without re-applying the override", () => {
    const active = reduce(
      reduce(initial, { type: "enable" }).state,
      resize(1280, 720, bounds(1500, 900)),
    ).state
    const { state, effects } = reduce(active, { type: "rebaseline", bounds: bounds(1600, 1000) })
    expect(effects).toEqual([])
    expect(state.baseline).toEqual(bounds(1600, 1000))
  })

  it("ignores rebaseline while not active (off or dormant)", () => {
    expect(reduce(initial, { type: "rebaseline", bounds: bounds(1, 1) }).state.baseline).toBeNull()
    const dormant: typeof initial = { enabled: true, dormant: true, baseline: null }
    expect(reduce(dormant, { type: "rebaseline", bounds: bounds(1, 1) }).state.baseline).toBeNull()
  })

  it("re-applies the override on rearm after going dormant", () => {
    const dormant: typeof initial = { enabled: true, dormant: true, baseline: null }
    const { state, effects } = reduce(dormant, {
      type: "rearm",
      canvas: { w: 1280, h: 720 },
      bounds: bounds(1500, 900),
    })
    expect(state.dormant).toBe(false)
    expect(state.baseline).toEqual(bounds(1500, 900))
    expect(effects).toEqual([
      { type: "applyOverride", metrics: deviceMetrics({ w: 1280, h: 720 }) },
    ])
  })

  it("ignores rearm when not dormant", () => {
    const active = reduce(
      reduce(initial, { type: "enable" }).state,
      resize(1280, 720, bounds(1500, 900)),
    ).state
    const { effects } = reduce(active, {
      type: "rearm",
      canvas: { w: 1280, h: 720 },
      bounds: bounds(1500, 900),
    })
    expect(effects).toEqual([])
  })
})
