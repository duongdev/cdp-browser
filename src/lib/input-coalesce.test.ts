import { describe, expect, it } from "vitest"
import { createBatcher, createHoverGate, createSingleFlight } from "./input-coalesce"

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

// Single-flight queue backing the web POST fallback: never more than one POST in
// flight, accumulated items merge between flights. Fake `post` returns a promise we
// resolve by hand so the test controls the in-flight window deterministically.
function sfHarness(merge: (items: number[]) => number[] = (i) => i) {
  const posts: { items: number[]; resolve: () => void; reject: () => void }[] = []
  const sf = createSingleFlight<number>({
    merge,
    post: (items) =>
      new Promise<void>((resolve, reject) => {
        posts.push({ items, resolve, reject })
      }),
  })
  return { sf, posts }
}

describe("input-coalesce single-flight", () => {
  it("sends immediately when nothing is in flight", () => {
    const { sf, posts } = sfHarness()
    sf.push([1, 2])
    expect(posts).toHaveLength(1)
    expect(posts[0].items).toEqual([1, 2])
  })

  it("holds subsequent pushes until the in-flight post resolves", async () => {
    const { sf, posts } = sfHarness()
    sf.push([1])
    sf.push([2])
    sf.push([3])
    expect(posts).toHaveLength(1)
    posts[0].resolve()
    await Promise.resolve()
    expect(posts).toHaveLength(2)
    expect(posts[1].items).toEqual([2, 3])
  })

  it("applies merge to the accumulated batch on the next flight", async () => {
    const { sf, posts } = sfHarness((items) => [items[items.length - 1]])
    sf.push([1])
    sf.push([2])
    sf.push([3])
    posts[0].resolve()
    await Promise.resolve()
    expect(posts[1].items).toEqual([3])
  })

  it("does not wedge when a post rejects", async () => {
    const { sf, posts } = sfHarness()
    sf.push([1])
    sf.push([2])
    posts[0].reject()
    await Promise.resolve()
    await Promise.resolve()
    expect(posts).toHaveLength(2)
    expect(posts[1].items).toEqual([2])
  })

  it("stays idle when there is nothing pending after a flight", async () => {
    const { sf, posts } = sfHarness()
    sf.push([1])
    posts[0].resolve()
    await Promise.resolve()
    expect(posts).toHaveLength(1)
  })
})

// Hover gate: a buttons-up move is held and only emitted once movement stops; a
// press/release/drag cancels the held move. Fake `delay` captures the stop callback so
// the test fires "movement stopped" deterministically.
function hgHarness() {
  const emitted: number[] = []
  let stop: (() => void) | null = null
  let cancels = 0
  const gate = createHoverGate<number>({
    delay: (cb) => {
      stop = cb
      return () => {
        cancels++
        stop = null
      }
    },
    emit: (item) => emitted.push(item),
  })
  const fireStop = () => {
    const cb = stop
    stop = null
    cb?.()
  }
  return { gate, emitted, fireStop, cancels: () => cancels }
}

describe("input-coalesce hover gate", () => {
  it("emits the resting position once movement stops", () => {
    const { gate, emitted, fireStop } = hgHarness()
    gate.move(1)
    expect(emitted).toEqual([])
    fireStop()
    expect(emitted).toEqual([1])
  })

  it("keeps only the latest move while still moving", () => {
    const { gate, emitted, fireStop } = hgHarness()
    gate.move(1)
    gate.move(2)
    gate.move(3)
    fireStop()
    expect(emitted).toEqual([3])
  })

  it("re-arms the stop timer on each move", () => {
    const { gate, cancels } = hgHarness()
    gate.move(1)
    gate.move(2)
    expect(cancels()).toBe(1) // the first timer was cancelled before re-arming
  })

  it("cancel() drops a held move so it never emits", () => {
    const { gate, emitted, fireStop } = hgHarness()
    gate.move(1)
    gate.cancel()
    fireStop()
    expect(emitted).toEqual([])
  })
})
