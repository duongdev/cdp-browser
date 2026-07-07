import { describe, expect, it, vi } from "vitest"
// @ts-expect-error — CJS module, no types
import { createSweepStatePersister, deserialize, serialize } from "./slack-sweep-state.js"

describe("serialize / deserialize", () => {
  it("round-trips watermark + seeded (Set <-> array)", () => {
    const state = { watermark: { T1: { C1: "111.0" } }, seeded: new Set(["T1", "T2"]) }

    const raw = serialize(state)
    expect(raw).toEqual({ watermark: { T1: { C1: "111.0" } }, seeded: ["T1", "T2"] })

    const back = deserialize(raw)
    expect(back.watermark).toEqual({ T1: { C1: "111.0" } })
    expect(back.seeded).toBeInstanceOf(Set)
    expect([...back.seeded]).toEqual(["T1", "T2"])
  })

  it("deserialize defaults a missing / corrupt file to empty state", () => {
    expect(deserialize(null)).toEqual({ watermark: {}, seeded: new Set() })
    expect(deserialize("garbage")).toEqual({ watermark: {}, seeded: new Set() })
    expect(deserialize({ watermark: 5, seeded: 7 })).toEqual({ watermark: {}, seeded: new Set() })
  })
})

describe("createSweepStatePersister", () => {
  function harness() {
    let fire: (() => void) | null = null
    const write = vi.fn()
    const state = { watermark: {} as Record<string, unknown>, seeded: new Set<string>() }
    const persister = createSweepStatePersister({
      read: () => null,
      write,
      getState: () => state,
      setTimer: (cb: () => void) => {
        fire = cb
        return 1 as unknown
      },
      clearTimer: vi.fn(),
      debounceMs: 2000,
    })
    return { persister, write, state, fireTimer: () => fire?.() }
  }

  it("coalesces a burst of scheduleFlush into one trailing write of the latest state", () => {
    const { persister, write, state, fireTimer } = harness()

    persister.scheduleFlush()
    persister.scheduleFlush()
    persister.scheduleFlush()
    expect(write).not.toHaveBeenCalled() // debounced

    state.watermark = { T1: { C1: "222.0" } } // mutate after scheduling
    fireTimer()

    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith({ watermark: { T1: { C1: "222.0" } }, seeded: [] })
  })

  it("flushSync writes immediately", () => {
    const { persister, write, state } = harness()
    state.seeded.add("T9")

    persister.flushSync()

    expect(write).toHaveBeenCalledWith({ watermark: {}, seeded: ["T9"] })
  })

  it("load returns the deserialized read()", () => {
    const write = vi.fn()
    const persister = createSweepStatePersister({
      read: () => ({ watermark: { T1: { C1: "5.0" } }, seeded: ["T1"] }),
      write,
      getState: () => ({ watermark: {}, seeded: new Set() }),
    })

    const loaded = persister.load()
    expect(loaded.watermark).toEqual({ T1: { C1: "5.0" } })
    expect([...loaded.seeded]).toEqual(["T1"])
  })
})
