import { describe, expect, it, vi } from "vitest"
// CommonJS shared core (ADR-0008): per-key debounced Slack sweep trigger.
import { createSweepScheduler } from "./sweep-scheduler"

/** Deterministic injectable timer queue (no real time). */
function fakeTimers() {
  let now = 0
  let id = 1
  const queue: { at: number; fn: () => void; id: number }[] = []
  return {
    setTimer: (fn: () => void, ms: number) => {
      const t = { at: now + ms, fn, id: id++ }
      queue.push(t)
      return t.id
    },
    clearTimer: (h: number) => {
      const i = queue.findIndex((t) => t.id === h)
      if (i >= 0) queue.splice(i, 1)
    },
    advance: (ms: number) => {
      now += ms
      // Snapshot due timers; callbacks may schedule new ones (not yet due).
      const due = queue.filter((t) => t.at <= now).sort((a, b) => a.at - b.at)
      for (const t of due) {
        const i = queue.indexOf(t)
        if (i >= 0) queue.splice(i, 1)
        t.fn()
      }
    },
  }
}

describe("createSweepScheduler", () => {
  it("runs the first request immediately (leading edge)", () => {
    const ft = fakeTimers()
    const run = vi.fn()
    const s = createSweepScheduler({
      run,
      windowMs: 300,
      setTimer: ft.setTimer,
      clearTimer: ft.clearTimer,
    })

    s.request("T1", { teamId: "T1" })

    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith({ teamId: "T1" })
  })

  it("coalesces same-key requests within the window into one trailing run with the latest payload", () => {
    const ft = fakeTimers()
    const run = vi.fn()
    const s = createSweepScheduler({
      run,
      windowMs: 300,
      setTimer: ft.setTimer,
      clearTimer: ft.clearTimer,
    })

    s.request("T1", { n: 1 }) // leading → runs
    s.request("T1", { n: 2 }) // within window → coalesced
    s.request("T1", { n: 3 }) // within window → coalesced (latest wins)
    expect(run).toHaveBeenCalledTimes(1)

    ft.advance(300) // trailing edge

    expect(run).toHaveBeenCalledTimes(2)
    expect(run).toHaveBeenLastCalledWith({ n: 3 })
  })

  it("does not run again at the window edge when nothing was coalesced", () => {
    const ft = fakeTimers()
    const run = vi.fn()
    const s = createSweepScheduler({
      run,
      windowMs: 300,
      setTimer: ft.setTimer,
      clearTimer: ft.clearTimer,
    })

    s.request("T1", {})
    ft.advance(300)

    expect(run).toHaveBeenCalledTimes(1)
  })

  it("treats different keys independently (each gets its own leading run)", () => {
    const ft = fakeTimers()
    const run = vi.fn()
    const s = createSweepScheduler({
      run,
      windowMs: 300,
      setTimer: ft.setTimer,
      clearTimer: ft.clearTimer,
    })

    s.request("T1", { k: "T1" })
    s.request("T2", { k: "T2" })

    expect(run).toHaveBeenCalledTimes(2)
  })

  it("runs immediately again once the window has closed", () => {
    const ft = fakeTimers()
    const run = vi.fn()
    const s = createSweepScheduler({
      run,
      windowMs: 300,
      setTimer: ft.setTimer,
      clearTimer: ft.clearTimer,
    })

    s.request("T1", { n: 1 }) // leading
    ft.advance(300) // window closes, nothing pending
    s.request("T1", { n: 2 }) // leading again

    expect(run).toHaveBeenCalledTimes(2)
    expect(run).toHaveBeenLastCalledWith({ n: 2 })
  })

  it("stop() cancels pending timers so no trailing run fires", () => {
    const ft = fakeTimers()
    const run = vi.fn()
    const s = createSweepScheduler({
      run,
      windowMs: 300,
      setTimer: ft.setTimer,
      clearTimer: ft.clearTimer,
    })

    s.request("T1", { n: 1 }) // leading run
    s.request("T1", { n: 2 }) // pending trailing
    s.stop()
    ft.advance(300)

    expect(run).toHaveBeenCalledTimes(1)
  })
})
