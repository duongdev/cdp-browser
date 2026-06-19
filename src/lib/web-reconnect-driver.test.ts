import { describe, expect, it, vi } from "vitest"
import { createReconnectDriver } from "./web-reconnect-driver"

// A controllable timer + connect stub so the effectful driver runs without real waits or
// sockets. `fireTimers` drains the queue (newest scheduled first matches the loop's single
// pending timer at a time); `connect` resolves whatever the test queues per call.
function harness(connectResults: Array<{ ok?: boolean; error?: string }>) {
  let queue: Array<{ cb: () => void; ms: number }> = []
  let id = 0
  const phases: Array<"reconnecting" | "lost"> = []
  let connectCalls = 0
  const connect = vi.fn(async (_tabId: string) => {
    const r = connectResults[connectCalls] ?? { error: "down" }
    connectCalls++
    return r
  })
  const driver = createReconnectDriver({
    connect,
    emit: (p) => phases.push(p),
    setTimer: (cb, ms) => {
      const handle = ++id as unknown as ReturnType<typeof setTimeout>
      queue.push({ cb, ms })
      return handle
    },
    clearTimer: () => {
      queue = []
    },
  })
  // Drain every pending timer (each scheduled retry fires once, possibly scheduling the next).
  async function fireTimers() {
    while (queue.length) {
      const { cb } = queue.shift() as { cb: () => void; ms: number }
      cb()
      await Promise.resolve()
      await Promise.resolve()
    }
  }
  return { driver, connect, phases, fireTimers, pendingCount: () => queue.length }
}

describe("createReconnectDriver.reconnectNow", () => {
  it("does nothing before any connect (no tab to reconnect to)", () => {
    const { driver, connect, phases } = harness([])
    driver.reconnectNow()
    expect(connect).not.toHaveBeenCalled()
    expect(phases).toEqual([])
  })

  it("immediately re-invokes connect for the last tab and emits reconnecting", async () => {
    const { driver, connect, phases } = harness([{ ok: true }])
    driver.noteConnect("tab-1")
    driver.reconnectNow()
    await Promise.resolve()
    await Promise.resolve()
    expect(connect).toHaveBeenCalledWith("tab-1")
    expect(connect).toHaveBeenCalledTimes(1)
    expect(phases).toContain("reconnecting")
  })

  it("falls into the bounded-backoff climb when the host is still down", async () => {
    // First reconnect attempt fails → it should schedule the next retry (one loop, not two).
    const { driver, connect, fireTimers } = harness([{ error: "down" }, { ok: true }])
    driver.noteConnect("tab-1")
    driver.reconnectNow()
    await Promise.resolve()
    await Promise.resolve()
    expect(connect).toHaveBeenCalledTimes(1) // the immediate attempt
    await fireTimers() // drain the scheduled backoff retry
    expect(connect).toHaveBeenCalledTimes(2)
  })

  it("is idempotent: rapid taps supersede, no stacked concurrent connects", async () => {
    // Two taps in a row. The first attempt's late resolve is discarded (stale generation),
    // so only the second tap's connect drives the outcome — no double live attempt promoted.
    let resolveFirst: ((r: { ok?: boolean; error?: string }) => void) | undefined
    const connect = vi
      .fn()
      .mockImplementationOnce(() => new Promise((res) => (resolveFirst = res)))
      .mockImplementationOnce(() => Promise.resolve({ ok: true }))
    const driver = createReconnectDriver({
      connect: connect as unknown as (tabId: string) => Promise<{ ok?: boolean; error?: string }>,
      emit: () => {},
      setTimer: (cb) => cb as unknown as ReturnType<typeof setTimeout>,
      clearTimer: () => {},
    })
    driver.noteConnect("tab-1")
    driver.reconnectNow() // first tap — connect hangs
    driver.reconnectNow() // second tap — supersedes the first
    // Now the first (stale) attempt resolves late. It must be discarded, not climb the loop.
    resolveFirst?.({ error: "down" })
    await Promise.resolve()
    await Promise.resolve()
    expect(connect).toHaveBeenCalledTimes(2) // exactly the two taps, no extra retry from the stale one
  })

  it("resets the backoff schedule to base — a tap after the ceiling reconnects from scratch", async () => {
    const phases: Array<"reconnecting" | "lost"> = []
    const connect = vi.fn(async () => ({ ok: true }))
    // maxAttempts 0 → the first drop gives up immediately (terminal "lost").
    const driver = createReconnectDriver({
      connect,
      emit: (p) => phases.push(p),
      config: { baseMs: 500, factor: 2, capMs: 16000, maxAttempts: 0 },
      setTimer: (cb) => cb as unknown as ReturnType<typeof setTimeout>,
      clearTimer: () => {},
    })
    driver.noteConnect("tab-1")
    driver.onDrop() // ceiling hit at once → "lost"
    expect(phases).toContain("lost")
    // A manual tap after the ceiling must still connect (reset to base, not stuck at giveUp).
    driver.reconnectNow()
    await Promise.resolve()
    await Promise.resolve()
    expect(connect).toHaveBeenCalledWith("tab-1")
  })
})
