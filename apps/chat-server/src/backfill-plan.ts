// Pure backfill paging logic (PSN-93, Workstream D). No I/O — the effectful engine (backfill.ts)
// fetches pages and this decides when to stop paging a conversation. A conversation is done when
// the provider cursor runs out (null) OR the oldest message in the last page reaches the cutoff
// (now − days). Kept pure so the stop condition is unit-testable without a provider.

export const DAY_MS = 86_400_000

/** The epoch-ms cutoff for a backfill window. Messages older than this are outside the window. */
export function cutoffFor(now: number, days: number): number {
  return now - Math.max(0, days) * DAY_MS
}

/** Stop paging this conversation when the cursor is exhausted OR the oldest fetched ts is at/below
 *  the cutoff (we've reached far enough back). `oldestTs` is the min ts of the page just fetched;
 *  Infinity when the page was empty (also a stop — nothing left). */
export function shouldStopBackfill(
  oldestTs: number,
  cutoff: number,
  cursor: string | null,
): boolean {
  if (cursor == null) return true
  if (!Number.isFinite(oldestTs)) return true
  return oldestTs <= cutoff
}

/** The min ts across a page of messages; Infinity for an empty page. */
export function pageOldestTs(messages: { ts?: number }[]): number {
  let oldest = Number.POSITIVE_INFINITY
  for (const m of messages) {
    const ts = Number(m.ts) || 0
    if (ts > 0 && ts < oldest) oldest = ts
  }
  return oldest
}
