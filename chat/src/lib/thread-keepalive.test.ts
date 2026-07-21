import { describe, expect, it } from "vitest"
import {
  EMPTY_KEEPALIVE,
  isMounted,
  KEEPALIVE_CAP,
  type KeepAliveState,
  openThread,
} from "./thread-keepalive"

describe("openThread — MRU keep-alive with bounded eviction", () => {
  it("mounts the first conversation and marks it active", () => {
    const s = openThread(EMPTY_KEEPALIVE, "a")
    expect(s).toEqual({ mounted: ["a"], active: "a" })
  })

  it("appends new conversations as most-recent (oldest → newest)", () => {
    let s = openThread(EMPTY_KEEPALIVE, "a")
    s = openThread(s, "b")
    s = openThread(s, "c")
    expect(s.mounted).toEqual(["a", "b", "c"])
    expect(s.active).toBe("c")
  })

  it("re-opening promotes to most-recent WITHOUT duplicating", () => {
    let s = openThread(EMPTY_KEEPALIVE, "a")
    s = openThread(s, "b")
    s = openThread(s, "a")
    expect(s.mounted).toEqual(["b", "a"])
    expect(s.active).toBe("a")
  })

  it("evicts the least-recently-viewed id past the cap", () => {
    let s: KeepAliveState = EMPTY_KEEPALIVE
    for (const id of ["a", "b", "c"]) s = openThread(s, id, 3)
    // Opening a 4th past cap=3 drops the oldest ("a").
    s = openThread(s, "d", 3)
    expect(s.mounted).toEqual(["b", "c", "d"])
    expect(s.active).toBe("d")
  })

  it("promoting a mounted id does not trigger eviction (no growth)", () => {
    let s: KeepAliveState = EMPTY_KEEPALIVE
    for (const id of ["a", "b", "c"]) s = openThread(s, id, 3)
    s = openThread(s, "a", 3)
    expect(s.mounted).toEqual(["b", "c", "a"])
  })

  it("does not mutate the input state", () => {
    const s0: KeepAliveState = { mounted: ["a"], active: "a" }
    const before = [...s0.mounted]
    openThread(s0, "b")
    expect(s0.mounted).toEqual(before)
  })

  it("has a sane default cap", () => {
    expect(KEEPALIVE_CAP).toBeGreaterThanOrEqual(4)
  })
})

describe("isMounted", () => {
  it("reports membership of the mounted set", () => {
    const s = openThread(openThread(EMPTY_KEEPALIVE, "a"), "b")
    expect(isMounted(s, "a")).toBe(true)
    expect(isMounted(s, "b")).toBe(true)
    expect(isMounted(s, "z")).toBe(false)
  })
})
