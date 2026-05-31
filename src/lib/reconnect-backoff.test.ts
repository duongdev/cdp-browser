import { describe, expect, it } from "vitest"
import { type BackoffConfig, initialBackoff, nextBackoff } from "./reconnect-backoff"

// 0.5s → 1s → 2s → 4s …, capped at 8s, give up after 6 tries.
const CFG: BackoffConfig = { baseMs: 500, factor: 2, capMs: 8000, maxAttempts: 6 }

// Drive a run of `n` consecutive drops from a fresh state, collecting each step.
function dropRun(n: number, cfg = CFG) {
  let state = initialBackoff()
  const steps = []
  for (let i = 0; i < n; i++) {
    const r = nextBackoff(state, "drop", cfg)
    state = r.state
    steps.push(r.step)
  }
  return steps
}

describe("reconnect-backoff", () => {
  describe("exponential growth", () => {
    it("grows each successive drop's delay by the factor from the base", () => {
      const steps = dropRun(4)
      expect(steps.map((s) => s.delayMs)).toEqual([500, 1000, 2000, 4000])
      expect(steps.every((s) => !s.giveUp)).toBe(true)
    })
  })

  describe("cap", () => {
    it("clamps the delay at the ceiling — past the knee every delay is capMs", () => {
      // 500, 1000, 2000, 4000, then 8000 (cap), 8000 (cap), …
      const steps = dropRun(6)
      expect(steps.map((s) => s.delayMs)).toEqual([500, 1000, 2000, 4000, 8000, 8000])
    })

    it("never returns a delay above the cap regardless of factor", () => {
      const cfg: BackoffConfig = { baseMs: 1000, factor: 3, capMs: 5000, maxAttempts: 20 }
      const steps = dropRun(20, cfg)
      expect(steps.every((s) => s.delayMs <= 5000)).toBe(true)
    })
  })

  describe("reset on success", () => {
    it("resets the next delay to the base after a successful connect", () => {
      let state = initialBackoff()
      // Climb a few rungs.
      for (const d of [500, 1000, 2000]) {
        const r = nextBackoff(state, "drop", CFG)
        state = r.state
        expect(r.step.delayMs).toBe(d)
      }
      // Success clears the counter.
      const ok = nextBackoff(state, "success", CFG)
      state = ok.state
      expect(ok.step.giveUp).toBe(false)
      // The next drop starts again from the base, not pinned at the prior rung.
      const after = nextBackoff(state, "drop", CFG)
      expect(after.step.delayMs).toBe(500)
    })
  })

  describe("max-attempts ceiling", () => {
    it("reports giveUp once the attempt budget is exhausted, with no further delay", () => {
      const steps = dropRun(7) // maxAttempts is 6
      // The first 6 attempts retry; the 7th exceeds the budget → give up.
      expect(steps.slice(0, 6).every((s) => !s.giveUp)).toBe(true)
      expect(steps[6].giveUp).toBe(true)
      expect(steps[6].delayMs).toBe(0)
    })

    it("a success before the ceiling lets the loop climb the full budget again", () => {
      let state = initialBackoff()
      // Burn 5 of 6 attempts.
      for (let i = 0; i < 5; i++) state = nextBackoff(state, "drop", CFG).state
      // Recover — budget resets.
      state = nextBackoff(state, "success", CFG).state
      // A fresh full run of drops must not give up until the budget is exhausted again.
      const steps = dropRun(6) // a fresh run mirrors the post-reset counter
      // Sanity: the post-success state also climbs the full budget.
      let s2 = state
      const fresh = []
      for (let i = 0; i < 6; i++) {
        const r = nextBackoff(s2, "drop", CFG)
        s2 = r.state
        fresh.push(r.step.giveUp)
      }
      expect(fresh).toEqual(steps.map((s) => s.giveUp))
      expect(fresh.every((g) => !g)).toBe(true)
    })
  })

  describe("purity", () => {
    it("does not mutate the input state — same input yields the same verdict", () => {
      const state = initialBackoff()
      const a = nextBackoff(state, "drop", CFG)
      const b = nextBackoff(state, "drop", CFG)
      // Calling twice on the same state is referentially transparent.
      expect(a.step).toEqual(b.step)
      // The original state object is untouched (no in-place attempt bump).
      expect(nextBackoff(state, "drop", CFG).step.delayMs).toBe(500)
    })
  })
})
