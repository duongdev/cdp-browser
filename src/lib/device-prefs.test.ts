import { describe, expect, it } from "vitest"
import {
  DEFAULT_DEVICE_PREFS,
  DEVICE_PREF_BASES,
  deviceKey,
  readDevicePrefs,
  writeDevicePrefs,
} from "./device-prefs"

const D1 = "device_aaa_1"
const D2 = "device_bbb_2"

describe("deviceKey", () => {
  it("joins base and deviceId with an underscore", () => {
    expect(deviceKey("qualityTier", D1)).toBe("qualityTier_device_aaa_1")
    expect(deviceKey("latencyHud", D2)).toBe("latencyHud_device_bbb_2")
  })
})

describe("readDevicePrefs — device slot wins", () => {
  it("prefers the device slot over the global qualityTier", () => {
    const ui = { qualityTier_device_aaa_1: "snappy", qualityTier: "sharp" }
    expect(readDevicePrefs(ui, D1).qualityTier).toBe("snappy")
  })

  it("reads inputTransport and latencyHud from their device slots", () => {
    const ui = { inputTransport_device_aaa_1: "batch", latencyHud_device_aaa_1: true }
    const prefs = readDevicePrefs(ui, D1)
    expect(prefs.inputTransport).toBe("batch")
    expect(prefs.latencyHud).toBe(true)
  })
})

describe("readDevicePrefs — qualityTier fallback (migration path)", () => {
  it("falls back to the global qualityTier when this device has no slot", () => {
    expect(readDevicePrefs({ qualityTier: "sharp" }, D1).qualityTier).toBe("sharp")
  })

  it("falls back to the balanced default when neither slot nor global is set", () => {
    expect(readDevicePrefs({}, D1).qualityTier).toBe("balanced")
  })
})

describe("readDevicePrefs — defaults for the client-only prefs", () => {
  it("defaults inputTransport to auto and latencyHud to false when unset", () => {
    const prefs = readDevicePrefs({}, D1)
    expect(prefs.inputTransport).toBe("auto")
    expect(prefs.latencyHud).toBe(false)
  })

  it("matches DEFAULT_DEVICE_PREFS on an empty ui-state", () => {
    expect(readDevicePrefs({}, D1)).toEqual(DEFAULT_DEVICE_PREFS)
  })
})

describe("readDevicePrefs — garbage degrades to defaults", () => {
  it("resolves out-of-enum / wrong-type values to their defaults", () => {
    const ui = {
      qualityTier_device_aaa_1: "ultra",
      inputTransport_device_aaa_1: "carrier-pigeon",
      latencyHud_device_aaa_1: "yes",
    }
    expect(readDevicePrefs(ui, D1)).toEqual(DEFAULT_DEVICE_PREFS)
  })

  it("treats latencyHud as true only for the boolean true (not 1 / '1' / 'true')", () => {
    expect(readDevicePrefs({ latencyHud_device_aaa_1: 1 }, D1).latencyHud).toBe(false)
    expect(readDevicePrefs({ latencyHud_device_aaa_1: "1" }, D1).latencyHud).toBe(false)
    expect(readDevicePrefs({ latencyHud_device_aaa_1: "true" }, D1).latencyHud).toBe(false)
    expect(readDevicePrefs({ latencyHud_device_aaa_1: false }, D1).latencyHud).toBe(false)
    expect(readDevicePrefs({ latencyHud_device_aaa_1: true }, D1).latencyHud).toBe(true)
  })
})

describe("readDevicePrefs — deviceId isolation", () => {
  it("reads a different slot per deviceId", () => {
    const ui = {
      inputTransport_device_aaa_1: "ws",
      inputTransport_device_bbb_2: "batch",
      qualityTier_device_aaa_1: "sharp",
      qualityTier_device_bbb_2: "snappy",
    }
    expect(readDevicePrefs(ui, D1).inputTransport).toBe("ws")
    expect(readDevicePrefs(ui, D2).inputTransport).toBe("batch")
    expect(readDevicePrefs(ui, D1).qualityTier).toBe("sharp")
    expect(readDevicePrefs(ui, D2).qualityTier).toBe("snappy")
  })
})

describe("writeDevicePrefs — emits only present keys, to device slots", () => {
  it("writes a single slot for a lone inputTransport change (no global)", () => {
    expect(writeDevicePrefs({ inputTransport: "ws" }, D1)).toEqual({
      inputTransport_device_aaa_1: "ws",
    })
  })

  it("returns an empty object for an empty partial", () => {
    expect(writeDevicePrefs({}, D1)).toEqual({})
  })

  it("emits latencyHud false (a present key), not just true", () => {
    expect(writeDevicePrefs({ latencyHud: false }, D1)).toEqual({
      latencyHud_device_aaa_1: false,
    })
  })
})

describe("writeDevicePrefs — qualityTier global shadow", () => {
  it("emits the device slot AND the plain global qualityTier shadow", () => {
    expect(writeDevicePrefs({ qualityTier: "snappy" }, D1)).toEqual({
      qualityTier_device_aaa_1: "snappy",
      qualityTier: "snappy",
    })
  })

  it("does NOT emit any global key for inputTransport or latencyHud", () => {
    const out = writeDevicePrefs({ inputTransport: "batch", latencyHud: true }, D1)
    expect(out).not.toHaveProperty("qualityTier")
    expect(out).not.toHaveProperty("inputTransport")
    expect(out).not.toHaveProperty("latencyHud")
  })

  it("emits all four keys when all three prefs change", () => {
    expect(
      writeDevicePrefs({ qualityTier: "sharp", inputTransport: "batch", latencyHud: true }, D1),
    ).toEqual({
      qualityTier_device_aaa_1: "sharp",
      qualityTier: "sharp",
      inputTransport_device_aaa_1: "batch",
      latencyHud_device_aaa_1: true,
    })
  })
})

describe("module constants", () => {
  it("exposes the three device-pref base names", () => {
    expect([...DEVICE_PREF_BASES]).toEqual(["qualityTier", "inputTransport", "latencyHud"])
  })
})
