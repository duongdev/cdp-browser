/**
 * Always-on link-latency metrics for the web build (t057). Two signals feed it
 * continuously and cost ~0 when nothing reads them:
 *
 *  - **WS RTT + jitter** — the WS uplink stamps a monotonic time on each ping; the server
 *    echoes a pong; the downlink folds the round-trip into an EWMA RTT plus an EWMA jitter
 *    (mean absolute deviation of RTT). RTT is measured *only* on the client clock
 *    (send-stamp → echo → receive-stamp); the server clock is never differenced for RTT.
 *  - **Frame age** — every Screencast Frame envelope carries a server send timestamp;
 *    frame age = `now − serverSendTs + clockOffset`, where `clockOffset ≈ rtt/2` corrects
 *    the client/server clock skew. So frame age stays meaningful even with an unsynced
 *    server clock.
 *
 * Pure (lib-style): `createRttEstimator` and the `frameAge`/`clockOffsetFromRtt` math take
 * samples and `now` values as inputs — no timers, no WS, no I/O — so they are fully
 * unit-testable. The effectful ping pump and pong/frame wiring live in the transport layer
 * (`uplink-router.ts` adapters send the ping; `downlink-dispatcher.ts` recognizes the pong
 * and hands the frame timestamp here). The module-level singleton (`notePing`/`notePong`/
 * `noteFrameAge` → `getLatencySnapshot`) is the always-on holder the HUD (t059) reads; it
 * is a thin shell over the same pure estimator. See docs/tasks/057.
 */

/** Current latency estimate. `available: false` ⇒ no usable measurement (no pong yet, or
 *  the WS path is down) — report unavailable rather than a stale or fabricated number. */
export interface RttSnapshot {
  rtt: number | null
  jitter: number | null
  available: boolean
}

export interface RttEstimator {
  /** Record an outstanding ping by its sequence number and send time (client monotonic). */
  onPing(seq: number, sentAtMs: number): void
  /** Fold the round-trip for `seq` into the EWMA. A pong with no matching outstanding ping
   *  (out-of-order, duplicate, or unknown) is ignored. */
  onPong(seq: number, nowMs: number): void
  snapshot(): RttSnapshot
  /** Drop all state — back to unavailable. Called on transport teardown / WS loss. */
  reset(): void
}

export interface RttEstimatorConfig {
  /** EWMA weight for the newest sample (0..1). Higher = more reactive, less smooth. */
  alpha: number
}

const DEFAULT_ALPHA = 0.2

export function createRttEstimator(
  config: RttEstimatorConfig = { alpha: DEFAULT_ALPHA },
): RttEstimator {
  const { alpha } = config
  let rtt: number | null = null
  let jitter: number | null = null
  // Outstanding ping send-time, keyed by seq. Bounded: a resolved/unknown pong deletes its
  // key, so a flaky link can't grow an unbounded map (the pump only keeps the latest few).
  const outstanding = new Map<number, number>()

  return {
    onPing(seq, sentAtMs) {
      outstanding.set(seq, sentAtMs)
    },
    onPong(seq, nowMs) {
      const sentAt = outstanding.get(seq)
      if (sentAt === undefined) return // no matching ping — out-of-order / duplicate / unknown
      outstanding.delete(seq)
      const sample = nowMs - sentAt
      if (rtt === null) {
        rtt = sample
        jitter = 0
        return
      }
      const deviation = Math.abs(sample - rtt)
      jitter = (jitter ?? 0) + alpha * (deviation - (jitter ?? 0))
      rtt = rtt + alpha * (sample - rtt)
    },
    snapshot() {
      return { rtt, jitter, available: rtt !== null }
    },
    reset() {
      rtt = null
      jitter = null
      outstanding.clear()
    },
  }
}

/** Frame age = `now − serverSendTs + clockOffset`, clamped to 0 (a negative result means
 *  clock skew or a future stamp — report 0, never a negative age). */
export function frameAge(nowMs: number, serverSendTs: number, clockOffsetMs: number): number {
  return Math.max(0, nowMs - serverSendTs + clockOffsetMs)
}

/** One-way clock-offset estimate (`rtt / 2`) used to correct frame age; 0 when RTT is
 *  unavailable. Deliberately the cheap, good-enough correction — not NTP-grade sync. */
export function clockOffsetFromRtt(rtt: number | null): number {
  return rtt === null ? 0 : rtt / 2
}

/** The always-on snapshot the HUD (t059) reads: current RTT/jitter plus the last frame age. */
export interface LatencySnapshot extends RttSnapshot {
  /** Age of the most recent Screencast Frame in ms (now − serverSendTs + rtt/2), or null
   *  when no server-stamped frame has arrived (e.g. SSE envelope without a timestamp). */
  frameAge: number | null
}

// ── Always-on singleton ──────────────────────────────────────────────────────
// One process-wide estimator + last frame age, fed by the transport effects. Runs without
// `?perf=1`; it allocates nothing per frame beyond the timestamp arithmetic and is never on
// the fan-out path. The web shim resets it on teardown so a stale number can't survive a
// reconnect.
const singleton = createRttEstimator()
let lastFrameAge: number | null = null

export function notePing(seq: number, sentAtMs: number): void {
  singleton.onPing(seq, sentAtMs)
}

export function notePong(seq: number, nowMs: number): void {
  singleton.onPong(seq, nowMs)
}

/** Record a Screencast Frame's age from its server send timestamp, correcting for the
 *  RTT-derived one-way offset. An absent/zero timestamp leaves frame age unavailable
 *  (the SSE envelope may not carry one) rather than fabricating a value. */
export function noteFrameAge(nowMs: number, serverSendTs: number | undefined | null): void {
  if (!serverSendTs) {
    lastFrameAge = null
    return
  }
  const offset = clockOffsetFromRtt(singleton.snapshot().rtt)
  lastFrameAge = frameAge(nowMs, serverSendTs, offset)
}

export function getLatencySnapshot(): LatencySnapshot {
  return { ...singleton.snapshot(), frameAge: lastFrameAge }
}

/** Clear the singleton — RTT/jitter/frame-age all back to unavailable. Called on WS
 *  loss / transport teardown so the HUD shows "unavailable", not a stale number. */
export function resetLatencyMetrics(): void {
  singleton.reset()
  lastFrameAge = null
}
