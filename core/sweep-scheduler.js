// Per-key debounced scheduler for Slack sweep triggers (t096, A6).
//
// `onCreds` and `onSlackSignal` can fire for the SAME workspace within
// milliseconds (a fresh cred-extraction is immediately followed by a hijack
// signal), so both calling `sweepWorkspace(rec)` directly double-sweeps. This
// coalesces rapid same-key triggers into a leading-edge run (preserves
// sub-second delivery) plus at most one trailing run if more arrived during the
// window (catches a message that landed mid-window). Different keys are
// independent. The 15s all-workspaces backstop (`runOnce`) does NOT route here —
// it has no per-workspace key.
//
// Timers are injected so the debounce is unit-testable with a fake clock.

function createSweepScheduler({
  run,
  windowMs = 300,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  const timers = new Map() // key → timer handle (window is open while present)
  const pending = new Map() // key → latest payload awaiting the trailing edge

  function arm(key) {
    const handle = setTimer(() => {
      timers.delete(key)
      if (pending.has(key)) {
        const payload = pending.get(key)
        pending.delete(key)
        run(payload)
        arm(key) // keep the window open so a burst can't slip a second leading run
      }
    }, windowMs)
    timers.set(key, handle)
  }

  return {
    request(key, payload) {
      if (timers.has(key)) {
        pending.set(key, payload) // inside the window — coalesce, latest wins
        return
      }
      run(payload) // leading edge
      arm(key)
    },
    stop() {
      for (const h of timers.values()) clearTimer(h)
      timers.clear()
      pending.clear()
    },
  }
}

module.exports = { createSweepScheduler }
