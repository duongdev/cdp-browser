/** Pure helpers for cross-device prefs polling (Workstream K, PSN-96).
 *  No React, no side effects — fully unit-testable. */

const GRACE_MS = 5_000

/** The minimal shape we compare for change-detection (prefs map + folderOrder). */
export interface PrefsFetchedShape {
  prefs: Record<string, unknown>
  folderOrder: string[]
}

/** Stable JSON signature for cheap deep-compare. */
export function prefsSignature(shape: PrefsFetchedShape): string {
  return JSON.stringify({ p: shape.prefs, o: shape.folderOrder })
}

/**
 * Decides whether a freshly-polled prefs payload should be applied.
 *
 * Returns false when:
 *  - The payload is identical to what we already have (no re-render needed).
 *  - A local write happened within the grace window (stale-read protection).
 */
export function shouldApplyPoll(
  fetchedSig: string,
  currentSig: string,
  lastLocalWriteAt: number,
  now: number,
): boolean {
  if (now - lastLocalWriteAt < GRACE_MS) return false
  return fetchedSig !== currentSig
}
