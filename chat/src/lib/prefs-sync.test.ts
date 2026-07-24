import { describe, expect, it } from "vitest"
import { prefsSignature, shouldApplyPoll } from "./prefs-sync"

const SHAPE_A = { prefs: { c1: { labels: ["a"] } }, folderOrder: ["work"] }
const SHAPE_B = { prefs: { c1: { labels: ["b"] } }, folderOrder: ["work"] }

describe("prefsSignature", () => {
  it("is stable for the same shape", () => {
    expect(prefsSignature(SHAPE_A)).toBe(prefsSignature(SHAPE_A))
  })
  it("differs when prefs change", () => {
    expect(prefsSignature(SHAPE_A)).not.toBe(prefsSignature(SHAPE_B))
  })
  it("differs when only folderOrder changes", () => {
    const withOrder = { prefs: SHAPE_A.prefs, folderOrder: ["personal", "work"] }
    expect(prefsSignature(SHAPE_A)).not.toBe(prefsSignature(withOrder))
  })
})

describe("shouldApplyPoll", () => {
  const sigA = prefsSignature(SHAPE_A)
  const sigB = prefsSignature(SHAPE_B)
  const NOW = 1_000_000

  it("applies when payload changed and outside grace window", () => {
    expect(shouldApplyPoll(sigB, sigA, NOW - 10_000, NOW)).toBe(true)
  })
  it("skips when payload is unchanged", () => {
    expect(shouldApplyPoll(sigA, sigA, NOW - 10_000, NOW)).toBe(false)
  })
  it("skips within grace window even if payload changed", () => {
    expect(shouldApplyPoll(sigB, sigA, NOW - 2_000, NOW)).toBe(false)
  })
  it("applies exactly at the grace boundary", () => {
    // 5 000 ms after the write = no longer in grace
    expect(shouldApplyPoll(sigB, sigA, NOW - 5_000, NOW)).toBe(true)
  })
  it("skips 1 ms inside the grace boundary", () => {
    expect(shouldApplyPoll(sigB, sigA, NOW - 4_999, NOW)).toBe(false)
  })
  it("applies with no prior local write (lastLocalWriteAt = 0)", () => {
    expect(shouldApplyPoll(sigB, sigA, 0, NOW)).toBe(true)
  })
})
