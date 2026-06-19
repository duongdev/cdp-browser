// Adaptive paint-ack watchdog window (t096, P2).
//
// The stranded-paint watchdog (web/server.mjs) frees the one-in-flight slot and re-acks the
// remote if a supporting client never acks a painted frame. A FIXED window trips early on a
// device that legitimately paints slower than it — degrading that device to eager self-ack and
// re-introducing the stale-frame backlog the paint-ack gate exists to prevent. This tracks an
// EWMA of observed paint-ack latency (markSent → client ack) and sizes the window to a multiple
// of it, never below a floor and never above a cap: a fast link keeps the tight floor, a
// genuinely-slow device gets the slack it needs, and a pathological sample can't run away.
//
// Pure: no timers, no clock — the server measures the latency and owns the setTimeout. Tested
// by paint-ack-pacer.test.ts.

function createPaintAckPacer({ floorMs = 1000, factor = 3, capMs = 5000, alpha = 0.3 } = {}) {
  let ewma = null
  return {
    record(latencyMs) {
      if (!(latencyMs >= 0)) return // ignore negative / NaN
      ewma = ewma === null ? latencyMs : alpha * latencyMs + (1 - alpha) * ewma
    },
    windowMs() {
      if (ewma === null) return floorMs
      return Math.max(floorMs, Math.min(capMs, Math.round(factor * ewma)))
    },
  }
}

module.exports = { createPaintAckPacer }
