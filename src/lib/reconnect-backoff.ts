/**
 * Reconnect backoff schedule — the pure half of auto-reconnect-on-real-drop (t040).
 *
 * On a real Remote Page drop the effectful wiring re-invokes `connect` on a
 * growing-then-capped cadence; this module decides *how long to wait* and *when to
 * give up*, with no idea of timers or sockets. It is a tiny state machine over an
 * attempt counter: each `"drop"` grows the delay exponentially (base × factorⁿ),
 * clamped at `capMs`; a `"success"` resets the counter to the base; once the attempt
 * budget (`maxAttempts`) is spent the verdict is `giveUp` (terminal "Disconnected").
 *
 * I/O-free by contract (no `setTimeout`/`WebSocket`/`fetch`/`document`): the caller
 * owns the timer that waits `delayMs` and the `connect` call it then fires. `t041`
 * (visible-tab re-climb) and `t042` (manual Reconnect) compose with this same state so
 * there is one backoff counter, not three. Tested by reconnect-backoff.test.ts.
 */

export interface BackoffConfig {
  /** First retry delay (ms) — the base every climb starts from. */
  baseMs: number
  /** Growth multiplier between successive attempts (e.g. 2 ⇒ 0.5s → 1s → 2s …). */
  factor: number
  /** Ceiling (ms) — a computed delay is clamped here and never exceeds it. */
  capMs: number
  /** Give up after this many retry attempts without a success. */
  maxAttempts: number
}

export type Outcome = "drop" | "success"

export interface BackoffStep {
  /** How long to wait before the next `connect` attempt. 0 when giving up. */
  delayMs: number
  /** Ceiling reached → stop retrying and settle the terminal "Disconnected" state. */
  giveUp: boolean
}

export interface BackoffState {
  /** Retries enacted since the last success (0 = fresh / just-recovered). */
  attempt: number
}

export function initialBackoff(): BackoffState {
  return { attempt: 0 }
}

/**
 * Advance the schedule by one outcome. Returns the next state plus the step the caller
 * enacts (wait `delayMs`, then `connect` — unless `giveUp`). Never mutates `state`.
 */
export function nextBackoff(
  state: BackoffState,
  outcome: Outcome,
  cfg: BackoffConfig,
): { state: BackoffState; step: BackoffStep } {
  if (outcome === "success") {
    return { state: { attempt: 0 }, step: { delayMs: 0, giveUp: false } }
  }
  // A drop consumes one attempt. Budget spent ⇒ terminal, no further delay.
  if (state.attempt >= cfg.maxAttempts) {
    return { state, step: { delayMs: 0, giveUp: true } }
  }
  const n = state.attempt // 0-based rung: base × factor⁰ on the first drop
  const delayMs = Math.min(cfg.baseMs * cfg.factor ** n, cfg.capMs)
  return { state: { attempt: state.attempt + 1 }, step: { delayMs, giveUp: false } }
}
