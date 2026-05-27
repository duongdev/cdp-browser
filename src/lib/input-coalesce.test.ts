import { describe, expect, it } from "vitest"
import { createBatcher } from "./input-coalesce"

// The web transport batches raw CDP commands ({method, params}) so high-frequency
// input doesn't become one HTTP POST each. Fake scheduler captures the flush
// callback so the test fires it deterministically (stands in for rAF).
function harness() {
  const sent: { seq: number; items: unknown[] }[] = []
  let pending: (() => void) | null = null
  const batcher = createBatcher<{ method: string; params?: unknown }>({
    schedule: (cb) => {
      pending = cb
    },
    send: (batch) => sent.push(batch),
  })
  const tick = () => {
    const cb = pending
    pending = null
    cb?.()
  }
  return { batcher, sent, tick }
}

const moveTo = (x: number) => ({
  method: "Input.dispatchMouseEvent",
  params: { type: "mouseMoved", x },
})
const wheel = (dy: number) => ({
  method: "Input.dispatchMouseEvent",
  params: { type: "mouseWheel", dy },
})
const click = () => ({ method: "Input.dispatchMouseEvent", params: { type: "mousePressed" } })

describe("input-coalesce batcher", () => {
  it("coalesces a burst into the latest coalesced item on flush", () => {
    const { batcher, sent, tick } = harness()
    batcher.coalesce(moveTo(1))
    batcher.coalesce(moveTo(2))
    batcher.coalesce(moveTo(3))
    tick()
    expect(sent).toHaveLength(1)
    expect(sent[0].items).toEqual([moveTo(3)])
  })

  it("accumulates appended items (e.g. wheel) without collapsing", () => {
    const { batcher, sent, tick } = harness()
    batcher.append(wheel(10))
    batcher.append(wheel(20))
    tick()
    expect(sent[0].items).toEqual([wheel(10), wheel(20)])
  })

  it("keeps appended items but replaces only coalesced ones", () => {
    const { batcher, sent, tick } = harness()
    batcher.append(wheel(10))
    batcher.coalesce(moveTo(1))
    batcher.coalesce(moveTo(2))
    tick()
    expect(sent[0].items).toEqual([wheel(10), moveTo(2)])
  })

  it("flushes the pending batch before an immediate item, in order", () => {
    const { batcher, sent } = harness()
    batcher.coalesce(moveTo(5))
    batcher.immediate(click())
    expect(sent).toHaveLength(2)
    expect(sent[0].items).toEqual([moveTo(5)])
    expect(sent[1].items).toEqual([click()])
  })

  it("assigns a monotonically increasing seq per batch", () => {
    const { batcher, sent, tick } = harness()
    batcher.coalesce(moveTo(1))
    tick()
    batcher.immediate(click())
    expect(sent.map((b) => b.seq)).toEqual([0, 1])
  })

  it("does nothing on flush when the queue is empty", () => {
    const { sent, tick } = harness()
    tick()
    expect(sent).toHaveLength(0)
  })
})
