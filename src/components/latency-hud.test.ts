import { describe, expect, it } from "vitest"
import { formatLatencyHud } from "./latency-hud"

describe("formatLatencyHud", () => {
  it("rounds rtt/jitter/frame-age to whole ms with a unit suffix", () => {
    const out = formatLatencyHud({ rtt: 42.4, jitter: 7.6, frameAge: 120.5, available: true }, "ws")
    expect(out.rtt).toBe("42ms")
    expect(out.jitter).toBe("8ms")
    expect(out.frameAge).toBe("121ms")
  })

  it("maps each transport mode to its short label", () => {
    const snap = { rtt: 10, jitter: 1, frameAge: 10, available: true }
    expect(formatLatencyHud(snap, "ws").transport).toBe("WS")
    expect(formatLatencyHud(snap, "stream").transport).toBe("Stream")
    expect(formatLatencyHud(snap, "batch").transport).toBe("Batch")
    expect(formatLatencyHud(snap, "auto").transport).toBe("Auto")
  })

  it("returns the neutral placeholder for null inputs (metrics not ready)", () => {
    const out = formatLatencyHud(
      { rtt: null, jitter: null, frameAge: null, available: false },
      "ws",
    )
    expect(out.rtt).toBe("—")
    expect(out.jitter).toBe("—")
    expect(out.frameAge).toBe("—")
  })

  it("returns the neutral placeholder for NaN inputs", () => {
    const out = formatLatencyHud({ rtt: NaN, jitter: NaN, frameAge: NaN, available: true }, "ws")
    expect(out.rtt).toBe("—")
    expect(out.jitter).toBe("—")
    expect(out.frameAge).toBe("—")
  })

  it("falls back to a dash transport label for a missing mode", () => {
    const snap = { rtt: 10, jitter: 1, frameAge: 10, available: true }
    expect(formatLatencyHud(snap, undefined).transport).toBe("—")
  })

  it("flags only the batch floor as the input-on-fallback path", () => {
    const snap = { rtt: 10, jitter: 1, frameAge: 10, available: true }
    // batch = neither WS nor streaming activated (a buffering proxy demoted both).
    expect(formatLatencyHud(snap, "batch").transportFallback).toBe(true)
    // The fast paths and the still-resolving / unknown states are not a fallback.
    expect(formatLatencyHud(snap, "ws").transportFallback).toBe(false)
    expect(formatLatencyHud(snap, "stream").transportFallback).toBe(false)
    expect(formatLatencyHud(snap, "auto").transportFallback).toBe(false)
    expect(formatLatencyHud(snap, undefined).transportFallback).toBe(false)
  })
})
