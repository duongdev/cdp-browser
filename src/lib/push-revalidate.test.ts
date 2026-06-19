import { describe, expect, it } from "vitest"
import { createPushRevalidateGate } from "./push-revalidate"

describe("push revalidate gate", () => {
  it("initially allows revalidation", () => {
    const gate = createPushRevalidateGate()
    expect(gate.shouldRevalidateNow(true)).toBe(true)
  })

  it("blocks revalidation after once-per-foreground has fired", () => {
    const gate = createPushRevalidateGate()
    expect(gate.shouldRevalidateNow(true)).toBe(true)
    // Call it again without resetting (still visible)
    expect(gate.shouldRevalidateNow(true)).toBe(false)
  })

  it("resets the gate when app goes hidden", () => {
    const gate = createPushRevalidateGate()
    expect(gate.shouldRevalidateNow(true)).toBe(true)
    expect(gate.shouldRevalidateNow(true)).toBe(false)
    // Now hide
    gate.shouldRevalidateNow(false)
    // Visible again — should fire once
    expect(gate.shouldRevalidateNow(true)).toBe(true)
  })

  it("does not revalidate when app is hidden", () => {
    const gate = createPushRevalidateGate()
    expect(gate.shouldRevalidateNow(false)).toBe(false)
    expect(gate.shouldRevalidateNow(false)).toBe(false)
  })

  it("tracks state across multiple hide/show cycles", () => {
    const gate = createPushRevalidateGate()
    // Cycle 1
    expect(gate.shouldRevalidateNow(true)).toBe(true)
    expect(gate.shouldRevalidateNow(true)).toBe(false)
    gate.shouldRevalidateNow(false)
    // Cycle 2
    expect(gate.shouldRevalidateNow(true)).toBe(true)
    expect(gate.shouldRevalidateNow(true)).toBe(false)
    gate.shouldRevalidateNow(false)
    // Cycle 3
    expect(gate.shouldRevalidateNow(true)).toBe(true)
  })

  it("returns false for hidden transitions in isolation", () => {
    const gate = createPushRevalidateGate()
    gate.shouldRevalidateNow(false)
    expect(gate.shouldRevalidateNow(false)).toBe(false)
  })
})
