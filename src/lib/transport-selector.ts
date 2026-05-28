export type InputTransportMode = "auto" | "ws" | "stream" | "batch"

interface TransportSelectorOptions {
  cache: { getItem(key: string): string | null; setItem(key: string, val: string): void }
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
