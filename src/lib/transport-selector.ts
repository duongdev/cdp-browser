import {
  type BackoffConfig,
  type BackoffState,
  initialBackoff,
  nextBackoff,
} from "./reconnect-backoff"

export type InputTransportMode = "auto" | "ws" | "stream" | "batch"

interface TransportSelectorOptions {
  cache: { getItem(key: string): string | null; setItem(key: string, val: string): void }
}

/**
 * The injected runtime facts the visible-tab WS re-climb (t041) decides over. All four are
 * supplied by the effectful caller (`cdp-web-transport.ts`) — the predicate never reads
 * `document`, `WebSocket`, or `fetch`, so it stays pure and unit-testable.
 */
export interface ReconnectState {
  /** `document.visibilityState === "visible"` — the timer goes quiet while backgrounded. */
  visible: boolean
  /** The shared WS socket is open and ready (so there is nothing to re-climb). */
  wsUp: boolean
  /** A WS open is already in flight — don't kick a second concurrent attempt. */
  attemptInFlight: boolean
  /** The advised transport is WS (Auto resolving to WS, or a manual Fastest pick). When the
   *  user has manually pinned Streaming/Basic this is false and the re-climb stands down. */
  intendsWs: boolean
}

/**
 * The pure verdict for the visible-tab WS re-climb (t041). True ⇔ the document is visible,
 * WS is the intended transport, WS is down, and no attempt is already in flight. Backgrounded,
 * WS-up, attempt-in-flight, or a manual non-WS pick all veto. No I/O — the caller injects the
 * four facts and owns the timer + the actual `openWs()` call.
 */
export function shouldReconnect(s: ReconnectState): boolean {
  return s.visible && s.intendsWs && !s.wsUp && !s.attemptInFlight
}

/**
 * The re-climb cadence — a thin shell over the t040 backoff schedule (`reconnect-backoff.ts`)
 * so the visible-tab timer spaces its attempts on the *same* growing-then-capped curve the
 * real-drop loop uses, rather than a second competing counter. `next()` advances one rung and
 * returns the delay to wait before the next attempt; `reset()` is called when WS comes back so
 * the curve restarts from the base. The `giveUp` ceiling is ignored here — while the tab stays
 * visible and WS-intended we keep re-attempting at the capped cadence (the user is looking at a
 * degraded session and wants the fast path back), so the schedule is used only for its spacing.
 */
export function createWsReclimbSchedule(config: BackoffConfig) {
  let state: BackoffState = initialBackoff()
  return {
    /** Advance one rung; returns the ms to wait before the next re-climb attempt. */
    next(): number {
      const { state: nextState, step } = nextBackoff(state, "drop", config)
      // Past the give-up budget the schedule stops growing (delay 0); pin to the cap so the
      // timer keeps a sane, spaced cadence instead of busy-looping.
      state = nextState
      return step.giveUp ? config.capMs : step.delayMs
    },
    /** WS recovered — restart the curve from the base for the next blip. */
    reset(): void {
      state = nextBackoff(state, "success", config).state
    },
  }
}

export function createTransportSelector(opts: TransportSelectorOptions) {
  const CACHE_KEY = "inputTransport_lastGood"
  const VALID_MODES: InputTransportMode[] = ["ws", "stream", "batch"]
  const RETRY_LIMIT = 3

  let activeMode: InputTransportMode = "auto"
  let manualMode: InputTransportMode | null = null
  let degradedFrom: InputTransportMode | null = null
  let retryCount = 0
  let lastFailedMode: InputTransportMode | null = null
  let manualModeError = false

  function getAutoChain(): InputTransportMode[] {
    const cached = opts.cache.getItem(CACHE_KEY) as InputTransportMode | null
    const lastGood = cached && VALID_MODES.includes(cached) ? cached : null

    if (lastGood) {
      // Start with last-good, then fill remaining chain
      const others = VALID_MODES.filter((m) => m !== lastGood)
      return [lastGood, ...others]
    }
    return ["ws", "stream", "batch"]
  }

  function getActiveMode(): InputTransportMode {
    return manualMode || activeMode
  }

  function isManualMode(): boolean {
    return manualMode !== null
  }

  function setManualMode(mode: InputTransportMode): void {
    manualMode = mode
    manualModeError = false
    activeMode = mode
    retryCount = 0
    lastFailedMode = null
  }

  function fallbackToAuto(): void {
    manualMode = null
    activeMode = "auto"
    manualModeError = false
  }

  function recordRetry(mode: InputTransportMode, succeeded: boolean): void {
    if (mode !== lastFailedMode) {
      retryCount = 0
      lastFailedMode = mode
    }

    if (succeeded) {
      retryCount = 0
      cacheSuccess(mode)
    } else {
      retryCount++
    }
  }

  function shouldDowngrade(mode: InputTransportMode): boolean {
    return lastFailedMode === mode && retryCount >= RETRY_LIMIT
  }

  function recordDowngrade(from: InputTransportMode, to: InputTransportMode): void {
    degradedFrom = from
    activeMode = to
    retryCount = 0
    lastFailedMode = null
  }

  function recordFailure(_mode: InputTransportMode): void {
    if (isManualMode()) {
      manualModeError = true
    }
  }

  function cacheSuccess(mode: InputTransportMode): void {
    opts.cache.setItem(CACHE_KEY, mode)
  }

  // Intentional no-op: a failure does not evict the last-good entry.
  // The cache records the last mode that worked; a transient failure on the
  // same mode shouldn't undo that so the Auto chain still starts there.
  function cacheFail(_mode: InputTransportMode): void {}

  function isDegraded(): boolean {
    return degradedFrom !== null
  }

  function clearDegraded(): void {
    degradedFrom = null
  }

  function getDegradedFrom(): InputTransportMode | null {
    return degradedFrom
  }

  function hasManualModeError(): boolean {
    return manualModeError
  }

  function onFocus(): InputTransportMode | null {
    if (!isDegraded()) {
      return null
    }

    // Re-probe the ideal mode
    const ideal = degradedFrom
    degradedFrom = null
    retryCount = 0
    lastFailedMode = null
    return ideal
  }

  function isBlocked(mode: InputTransportMode): boolean {
    return shouldDowngrade(mode)
  }

  return {
    getAutoChain,
    getActiveMode,
    isManualMode,
    setManualMode,
    fallbackToAuto,
    recordRetry,
    shouldDowngrade,
    recordDowngrade,
    recordFailure,
    cacheSuccess,
    cacheFail,
    isDegraded,
    clearDegraded,
    getDegradedFrom,
    hasManualModeError,
    onFocus,
    isBlocked,
  }
}
