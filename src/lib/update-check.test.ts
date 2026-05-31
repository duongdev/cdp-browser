import { describe, expect, it, vi } from "vitest"
import { isUpdateAvailable, startUpdateCheck } from "./update-check"

describe("isUpdateAvailable", () => {
  it("is true when both shas are real and differ", () => {
    expect(isUpdateAvailable("a6b99f5", "c2c658c")).toBe(true)
  })

  it("is false when the shas are equal", () => {
    expect(isUpdateAvailable("a6b99f5", "a6b99f5")).toBe(false)
  })

  it("is false when either sha is empty", () => {
    expect(isUpdateAvailable("", "c2c658c")).toBe(false)
    expect(isUpdateAvailable("a6b99f5", "")).toBe(false)
  })

  it("is false when either sha is unknown", () => {
    expect(isUpdateAvailable("unknown", "c2c658c")).toBe(false)
    expect(isUpdateAvailable("a6b99f5", "unknown")).toBe(false)
  })

  it("is false when either sha is dev", () => {
    expect(isUpdateAvailable("dev", "c2c658c")).toBe(false)
    expect(isUpdateAvailable("a6b99f5", "dev")).toBe(false)
  })
})

describe("startUpdateCheck", () => {
  it("fires onUpdate once when a newer build appears on poll", async () => {
    const onUpdate = vi.fn()
    let serverSha = "a6b99f5"
    const fetchServerVersion = vi.fn(async () => ({ version: "0.1.0", sha: serverSha }))
    const timer: { tick: (() => void) | null } = { tick: null }
    const handle = startUpdateCheck({
      currentSha: "a6b99f5",
      fetchServerVersion,
      onUpdate,
      intervalMs: 1000,
      setTimer: (fn) => {
        timer.tick = fn
        return 1
      },
      clearTimer: () => {},
    })

    await handle.check()
    expect(onUpdate).not.toHaveBeenCalled()

    serverSha = "c2c658c"
    await handle.check()
    expect(onUpdate).toHaveBeenCalledTimes(1)

    // Debounced — a second detection does not re-fire.
    await handle.check()
    expect(onUpdate).toHaveBeenCalledTimes(1)

    expect(typeof timer.tick).toBe("function")
    handle.stop()
  })

  it("fires onUpdate once when two activations race (focus + visibilitychange)", async () => {
    const onUpdate = vi.fn()
    // Defer the fetch so both check() calls are in flight before either resolves.
    const deferred: { resolve: (v: { version: string; sha: string }) => void } = {
      resolve: () => {},
    }
    const fetchServerVersion = vi.fn(
      () =>
        new Promise<{ version: string; sha: string }>((resolve) => {
          deferred.resolve = resolve
        }),
    )
    const handle = startUpdateCheck({
      currentSha: "a6b99f5",
      fetchServerVersion,
      onUpdate,
      intervalMs: 1000,
      setTimer: () => 1,
      clearTimer: () => {},
    })

    // window.focus and visibilitychange→visible fire back-to-back, both call check().
    const first = handle.check()
    const second = handle.check()

    // The in-flight latch collapses the two activations into a single fetch.
    expect(fetchServerVersion).toHaveBeenCalledTimes(1)

    deferred.resolve({ version: "0.1.0", sha: "c2c658c" })
    await Promise.all([first, second])

    expect(onUpdate).toHaveBeenCalledTimes(1)
    handle.stop()
  })

  it("retries after a fetch failure (the failure does not permanently latch)", async () => {
    const onUpdate = vi.fn()
    let attempt = 0
    const fetchServerVersion = vi.fn(async () => {
      attempt += 1
      if (attempt === 1) throw new Error("network")
      return { version: "0.1.0", sha: "c2c658c" }
    })
    const handle = startUpdateCheck({
      currentSha: "a6b99f5",
      fetchServerVersion,
      onUpdate,
      intervalMs: 1000,
      setTimer: () => 1,
      clearTimer: () => {},
    })

    await handle.check()
    expect(onUpdate).not.toHaveBeenCalled()

    await handle.check()
    expect(onUpdate).toHaveBeenCalledTimes(1)
    handle.stop()
  })

  it("polls on the interval via the injected timer", async () => {
    const onUpdate = vi.fn()
    const fetchServerVersion = vi.fn(async () => ({ version: "0.1.0", sha: "c2c658c" }))
    const timer: { tick: (() => void) | null } = { tick: null }
    startUpdateCheck({
      currentSha: "a6b99f5",
      fetchServerVersion,
      onUpdate,
      intervalMs: 1000,
      setTimer: (fn) => {
        timer.tick = fn
        return 1
      },
      clearTimer: () => {},
    })

    expect(timer.tick).not.toBeNull()
    // Fire the interval callback; it should poll and detect the newer build.
    timer.tick?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(fetchServerVersion).toHaveBeenCalled()
  })

  it("swallows fetch errors without throwing", async () => {
    const onUpdate = vi.fn()
    const fetchServerVersion = vi.fn(async () => {
      throw new Error("network")
    })
    const handle = startUpdateCheck({
      currentSha: "a6b99f5",
      fetchServerVersion,
      onUpdate,
      intervalMs: 1000,
      setTimer: () => 1,
      clearTimer: () => {},
    })

    await expect(handle.check()).resolves.toBeUndefined()
    expect(onUpdate).not.toHaveBeenCalled()
    handle.stop()
  })

  it("clears the interval timer on stop", () => {
    const clearTimer = vi.fn()
    const handle = startUpdateCheck({
      currentSha: "a6b99f5",
      fetchServerVersion: async () => ({ version: "0.1.0", sha: "a6b99f5" }),
      onUpdate: () => {},
      intervalMs: 1000,
      setTimer: () => 42,
      clearTimer,
    })
    handle.stop()
    expect(clearTimer).toHaveBeenCalledWith(42)
  })
})
