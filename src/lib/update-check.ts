// Version-poll update check for the web PWA (t044). On a long-lived page,
// registration.update() re-fetches the *same* /sw.js?v=OLD URL → identical bytes → no
// updatefound → the SW-based prompt never fires for a fresh deploy. So we also poll
// GET /api/version and compare its git sha to the build-time sha baked into this bundle;
// a difference means a newer build is live and we surface the same reload prompt.
//
// The pure verdict (isUpdateAvailable) is split from the effectful poller (startUpdateCheck)
// so the verdict is trivially testable and the timer/fetch are injectable.

/** A sha that carries no real build identity — never treat it as comparable. */
function isRealSha(sha: string): boolean {
  return sha !== "" && sha !== "unknown" && sha !== "dev"
}

/** True only when both shas are real (non-empty, not unknown/dev) and differ. */
export function isUpdateAvailable(currentSha: string, serverSha: string): boolean {
  if (!isRealSha(currentSha) || !isRealSha(serverSha)) return false
  return currentSha !== serverSha
}

interface ServerVersion {
  version: string
  sha: string
}

interface StartUpdateCheckOptions {
  /** This bundle's build-time git sha (__GIT_SHA__). */
  currentSha: string
  /** Fetches GET /api/version. Injected for tests. */
  fetchServerVersion: () => Promise<ServerVersion>
  /** Fired once when a newer build is first detected (debounced). */
  onUpdate: () => void
  /** Poll cadence in ms. */
  intervalMs: number
  /** Injectable timers (default to the global window timers). */
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export interface UpdateCheckHandle {
  /** Polls once now (wired to visibilitychange→visible and window focus). */
  check: () => Promise<void>
  /** Stops the interval poll. */
  stop: () => void
}

/**
 * Polls fetchServerVersion() on an interval and exposes check() to run on app activate.
 * Calls onUpdate() exactly once when a newer build is detected (debounced so a backgrounded
 * page that keeps polling doesn't re-fire). Fetch failures are swallowed (offline / mid-deploy).
 */
export function startUpdateCheck(opts: StartUpdateCheckOptions): UpdateCheckHandle {
  const setTimer = opts.setTimer ?? ((fn, ms) => window.setInterval(fn, ms))
  const clearTimer = opts.clearTimer ?? ((h) => window.clearInterval(h as number))

  let fired = false
  let inFlight = false
  const check = async (): Promise<void> => {
    // `fired` debounces after a confirmed update; `inFlight` is a synchronous latch so two
    // back-to-back activations (iPad window.focus + visibilitychange→visible) collapse into
    // one fetch — without it both pass `fired` before either fetch resolves and onUpdate
    // fires twice. The latch clears in `finally` so a fetch failure still allows a retry.
    if (fired || inFlight) return
    inFlight = true
    try {
      const server = await opts.fetchServerVersion()
      if (isUpdateAvailable(opts.currentSha, server?.sha ?? "")) {
        fired = true
        opts.onUpdate()
      }
    } catch {
      // Swallow — offline / mid-deploy. The latch clears below so the next activation retries.
    } finally {
      inFlight = false
    }
  }

  const handle = setTimer(() => {
    void check()
  }, opts.intervalMs)

  return {
    check,
    stop: () => clearTimer(handle),
  }
}
