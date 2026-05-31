import { describe, expect, it } from "vitest"
// CommonJS shared core (ADR-0008): the one-in-flight frame-ack gate. Pure, no timers —
// the server owns the watchdog timer and calls reset()/ackReceived() into it.
import { createAckGate } from "./frame-ack-gate"

describe("createAckGate", () => {
  it("starts ready (nothing outstanding)", () => {
    const gate = createAckGate()
    expect(gate.mayProceed()).toBe(true)
  })

  it("blocks once a frame is marked sent and clears on its ack", () => {
    const gate = createAckGate()
    gate.markSent(1)
    expect(gate.mayProceed()).toBe(false)
    gate.ackReceived(1)
    expect(gate.mayProceed()).toBe(true)
  })

  it("holds a second frame while one is outstanding (coalesce-to-latest, not queue)", () => {
    const gate = createAckGate()
    gate.markSent(1)
    // A second markSent while outstanding does not stack — it tracks the latest sent.
    gate.markSent(2)
    expect(gate.mayProceed()).toBe(false)
    // The ack for the latest sent releases exactly one slot.
    gate.ackReceived(2)
    expect(gate.mayProceed()).toBe(true)
  })

  it("releases on the latest outstanding ack even if an older ack id arrives", () => {
    const gate = createAckGate()
    gate.markSent(5)
    // A stale ack for a frame we never tracked as outstanding is ignored.
    gate.ackReceived(3)
    expect(gate.mayProceed()).toBe(false)
    gate.ackReceived(5)
    expect(gate.mayProceed()).toBe(true)
  })

  it("treats a duplicate ack as a no-op (does not free a slot twice / go negative)", () => {
    const gate = createAckGate()
    gate.markSent(1)
    gate.ackReceived(1)
    gate.ackReceived(1) // duplicate — no effect
    expect(gate.mayProceed()).toBe(true)
    // A fresh send still blocks (the duplicate didn't pre-credit a slot).
    gate.markSent(2)
    expect(gate.mayProceed()).toBe(false)
  })

  it("ignores an ack when nothing is outstanding", () => {
    const gate = createAckGate()
    gate.ackReceived(9)
    expect(gate.mayProceed()).toBe(true)
    gate.markSent(1)
    expect(gate.mayProceed()).toBe(false)
  })

  it("reset() clears the outstanding state (Downlink close / reconnect)", () => {
    const gate = createAckGate()
    gate.markSent(1)
    expect(gate.mayProceed()).toBe(false)
    gate.reset()
    expect(gate.mayProceed()).toBe(true)
  })

  it("reports the outstanding session id (for the watchdog to re-ack on timeout)", () => {
    const gate = createAckGate()
    expect(gate.outstanding()).toBe(null)
    gate.markSent(7)
    expect(gate.outstanding()).toBe(7)
    gate.ackReceived(7)
    expect(gate.outstanding()).toBe(null)
  })
})
