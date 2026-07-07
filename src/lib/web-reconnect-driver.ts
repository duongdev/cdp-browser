/**
 * Web build — the effectful auto-reconnect loop, lifted out of `cdp-web-transport.ts` so it
 * has an isolated test surface (t096, A5). It drives the pure `reconnect-backoff` schedule:
 * the assembler hangs this off the Downlink's real-drop signal and the manual Reconnect tap.
 */

import {
  type BackoffConfig,
  type BackoffState,
  initialBackoff,
  nextBackoff,
} from "./reconnect-backoff"

// Bounded-backoff defaults for auto-reconnect on a real drop (t040). 0.5s → 1s → 2s →
// 4s → 8s → 16s (capped at 16s), giving up after 10 tries (~2 min of retries) — long
// enough to ride out a host restart / network blip, bounded so a dead host settles on a
// terminal "Disconnected" instead of retrying forever.
export const RECONNECT_CONFIG: BackoffConfig = {
  baseMs: 500,
  factor: 2,
  capMs: 16000,
  maxAttempts: 10,
}

/**
 * The effectful reconnect loop (t040) — the pure schedule's caller. On a real Remote Page
 * drop it re-invokes `connect(lastTabId)` on the bounded-backoff cadence, surfacing a
 * "reconnecting" phase while it retries and a terminal "lost" once the ceiling is hit. A
 * fresh `connect` (a tab switch, or a retry that lands) resets the schedule and cancels any
 * queued retry; `stop()` (host-initiated teardown) does the same. The server-side
 * `connectId` race-guard discards a retry that resolves after a newer connect, so this loop
 * never promotes a stale socket — it just drives `connect` through the same guard.
 */
export function createReconnectDriver(opts: {
  connect: (tabId: string) => Promise<{ ok?: boolean; error?: string }>
  emit: (phase: "reconnecting" | "lost") => void
  config?: BackoffConfig
  setTimer?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (h: ReturnType<typeof setTimeout>) => void
}) {
  const cfg = opts.config ?? RECONNECT_CONFIG
  const setTimer = opts.setTimer ?? ((cb, ms) => setTimeout(cb, ms))
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h))

  let state: BackoffState = initialBackoff()
  let lastTabId: string | null = null
  let pending: ReturnType<typeof setTimeout> | null = null
  // Bumped on every connect()/stop(); a retry whose timer fires for a stale generation is
  // dropped (the renderer-side mirror of the connector's connectId guard).
  let generation = 0

  function cancelPending() {
    if (pending !== null) {
      clearTimer(pending)
      pending = null
    }
  }

  function scheduleNext() {
    const { state: next, step } = nextBackoff(state, "drop", cfg)
    state = next
    if (step.giveUp) {
      opts.emit("lost")
      return
    }
    opts.emit("reconnecting")
    const myGen = generation
    pending = setTimer(async () => {
      pending = null
      if (myGen !== generation || lastTabId === null) return
      // A rejected connect POST (network down mid-retry) must be a failed attempt, not an
      // escaped rejection that wedges the loop on "reconnecting" forever (t099).
      const result = await opts
        .connect(lastTabId)
        .catch((): { ok?: boolean; error?: string } => ({ error: "connect threw" }))
      if (myGen !== generation) return // a newer connect/stop superseded this retry
      if (result?.ok) {
        state = nextBackoff(state, "success", cfg).state
        return
      }
      // "cancelled" means a newer connect took the slot — stop quietly (gen already bumped
      // in that case). Any other error is the host still being down → climb the next rung.
      if (result?.error !== "cancelled") scheduleNext()
    }, step.delayMs)
  }

  return {
    /** A fresh, intentional connect (tab switch or initial). Records the target, resets the
     *  schedule, and cancels any queued retry so the loop never races a deliberate connect. */
    noteConnect(tabId: string) {
      lastTabId = tabId
      generation++
      cancelPending()
      state = nextBackoff(state, "success", cfg).state
    },
    /** A real drop surfaced by the Downlink. Kicks the backoff loop. */
    onDrop() {
      if (lastTabId === null) {
        // Never connected (or host-disconnected) — surface the terminal loss, don't retry.
        opts.emit("lost")
        return
      }
      cancelPending()
      scheduleNext()
    },
    /** A manual force-reconnect (status-bar / settings tap, later the ⌘K command). Cancels
     *  any pending backoff timer, resets the schedule to its base delay, and re-enters the
     *  *same* `connect` path the auto-loop uses — immediately, for the last tab — never a
     *  second competing loop. Bumping `generation` first supersedes any queued auto-retry
     *  (the renderer mirror of the server `connectId` guard), so rapid taps don't stack: a
     *  later tap discards the earlier attempt instead of opening a second socket. */
    reconnectNow() {
      if (lastTabId === null) return // nothing to reconnect to (never connected / host gone)
      generation++
      cancelPending()
      state = initialBackoff()
      const tabId = lastTabId
      const myGen = generation
      opts.emit("reconnecting")
      void opts
        .connect(tabId)
        .catch(() => ({ error: "connect threw" }) as { ok?: boolean; error?: string })
        .then((result) => {
          if (myGen !== generation) return // a newer connect/tap/stop superseded this attempt
          if (result?.ok) {
            state = nextBackoff(state, "success", cfg).state
            return
          }
          // Host still down → fall into the normal bounded-backoff climb (one loop, shared cfg).
          if (result?.error !== "cancelled") scheduleNext()
        })
    },
    /** Host-initiated teardown — stop retrying and forget the target. */
    stop() {
      generation++
      cancelPending()
      lastTabId = null
      state = initialBackoff()
    },
  }
}
