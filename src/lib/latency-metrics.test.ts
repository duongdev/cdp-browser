import { describe, expect, it } from "vitest"
import {
  clockOffsetFromRtt,
  createRttEstimator,
  frameAge,
  getLatencySnapshot,
  noteFrameAge,
  notePing,
  notePong,
  resetLatencyMetrics,
} from "./latency-metrics"

// Half-weight EWMA makes the arithmetic easy to assert by hand.
const ALPHA = 0.5

describe("latency-metrics", () => {
  describe("createRttEstimator — RTT EWMA", () => {
    it("seeds RTT to the raw first sample (no warm-up artifact)", () => {
      const est = createRttEstimator({ alpha: ALPHA })
      est.onPing(1, 100)
      est.onPong(1, 140) // RTT 40
      expect(est.snapshot().rtt).toBe(40)
    })

    it("folds subsequent pongs in via EWMA toward alpha", () => {
      const est = createRttEstimator({ alpha: ALPHA })
      est.onPing(1, 0)
      est.onPong(1, 40) // seed RTT 40
      est.onPing(2, 100)
      est.onPong(2, 180) // sample 80 → 40 + 0.5*(80-40) = 60
      expect(est.snapshot().rtt).toBe(60)
    })
  })

  describe("createRttEstimator — jitter", () => {
    it("jitter is the EWMA of abs(sample − rttBefore); a steady RTT drives it toward 0", () => {
      const est = createRttEstimator({ alpha: ALPHA })
      // Three identical 40ms round-trips.
      for (let seq = 1; seq <= 3; seq++) {
        est.onPing(seq, seq * 100)
        est.onPong(seq, seq * 100 + 40)
      }
      // First sample seeds jitter to 0 (no prior RTT to deviate from); steady stays 0.
      expect(est.snapshot().jitter).toBe(0)
    })

    it("an alternating RTT keeps jitter positive", () => {
      const est = createRttEstimator({ alpha: ALPHA })
      const samples = [40, 80, 40, 80, 40, 80]
      samples.forEach((rtt, i) => {
        const seq = i + 1
        const t = seq * 1000
        est.onPing(seq, t)
        est.onPong(seq, t + rtt)
      })
      expect(est.snapshot().jitter).toBeGreaterThan(0)
    })
  })

  describe("createRttEstimator — out-of-order / unknown pongs", () => {
    it("ignores a pong with no matching outstanding ping", () => {
      const est = createRttEstimator({ alpha: ALPHA })
      est.onPing(1, 0)
      est.onPong(1, 40) // RTT 40
      est.onPong(99, 9999) // unknown seq — must not fold in
      expect(est.snapshot().rtt).toBe(40)
    })

    it("ignores a duplicate pong for an already-resolved ping", () => {
      const est = createRttEstimator({ alpha: ALPHA })
      est.onPing(1, 0)
      est.onPong(1, 40)
      est.onPong(1, 200) // duplicate for the same seq — ignored
      expect(est.snapshot().rtt).toBe(40)
    })
  })

  describe("createRttEstimator — availability", () => {
    it("reports unavailable before any pong and available after the first", () => {
      const est = createRttEstimator({ alpha: ALPHA })
      expect(est.snapshot()).toEqual({ rtt: null, jitter: null, available: false })
      est.onPing(1, 0)
      est.onPong(1, 40)
      expect(est.snapshot()).toEqual({ rtt: 40, jitter: 0, available: true })
    })

    it("reset() returns to the unavailable state", () => {
      const est = createRttEstimator({ alpha: ALPHA })
      est.onPing(1, 0)
      est.onPong(1, 40)
      est.reset()
      expect(est.snapshot()).toEqual({ rtt: null, jitter: null, available: false })
    })
  })

  describe("frameAge", () => {
    it("returns now − serverSendTs + clockOffset", () => {
      expect(frameAge(1000, 950, 10)).toBe(60)
    })

    it("clamps a negative result (clock skew / future stamp) to 0", () => {
      expect(frameAge(1000, 1100, 0)).toBe(0)
      expect(frameAge(1000, 990, -50)).toBe(0)
    })
  })

  describe("clockOffsetFromRtt", () => {
    it("returns the one-way estimate rtt/2", () => {
      expect(clockOffsetFromRtt(40)).toBe(20)
    })

    it("returns 0 when RTT is unavailable", () => {
      expect(clockOffsetFromRtt(null)).toBe(0)
    })
  })

  describe("always-on singleton accessor", () => {
    it("getLatencySnapshot() reflects the fed RTT/jitter and last frame age", () => {
      resetLatencyMetrics()
      // Unavailable until the first pong.
      expect(getLatencySnapshot()).toEqual({
        rtt: null,
        jitter: null,
        available: false,
        frameAge: null,
      })
      notePing(1, 0)
      notePong(1, 40) // RTT 40 → offset 20
      // server stamped 950, now 1000, offset 20 → age 70
      noteFrameAge(1000, 950)
      const snap = getLatencySnapshot()
      expect(snap.rtt).toBe(40)
      expect(snap.available).toBe(true)
      expect(snap.frameAge).toBe(70)
    })

    it("frame age reports null when no server timestamp has been recorded", () => {
      resetLatencyMetrics()
      notePing(1, 0)
      notePong(1, 40)
      expect(getLatencySnapshot().frameAge).toBe(null)
    })

    it("noteFrameAge with an absent/zero server timestamp leaves frame age null", () => {
      resetLatencyMetrics()
      noteFrameAge(1000, undefined)
      expect(getLatencySnapshot().frameAge).toBe(null)
      noteFrameAge(1000, 0)
      expect(getLatencySnapshot().frameAge).toBe(null)
    })

    it("resetLatencyMetrics clears the singleton (e.g. on transport teardown)", () => {
      resetLatencyMetrics()
      notePing(1, 0)
      notePong(1, 40)
      noteFrameAge(1000, 950)
      resetLatencyMetrics()
      expect(getLatencySnapshot()).toEqual({
        rtt: null,
        jitter: null,
        available: false,
        frameAge: null,
      })
    })
  })
})
