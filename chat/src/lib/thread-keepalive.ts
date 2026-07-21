/** Keep-alive state for mounted thread panes (t110). `mounted` is MRU order
 *  (oldest → newest); `active` is the conversation currently shown (last opened). */
export interface KeepAliveState {
  mounted: string[]
  active: string
}

export const EMPTY_KEEPALIVE: KeepAliveState = { mounted: [], active: "" }

/** Bound on simultaneously mounted thread panes. Past this the least-recently-viewed
 *  pane is evicted so a long session keeps a finite number of fetched threads alive. */
export const KEEPALIVE_CAP = 8

/**
 * Open (or re-open) a conversation: make it active and most-recent without
 * duplicating, evicting the least-recently-viewed id when the mounted set grows
 * past `cap`. Immutable — returns new arrays, never mutates `state`. Mirrors
 * `active-order.ts`'s MRU semantics (filter-out then append to the tail).
 */
export function openThread(
  state: KeepAliveState,
  convId: string,
  cap: number = KEEPALIVE_CAP,
): KeepAliveState {
  const promoted = [...state.mounted.filter((id) => id !== convId), convId]
  const mounted = promoted.length > cap ? promoted.slice(promoted.length - cap) : promoted
  return { mounted, active: convId }
}

export function isMounted(state: KeepAliveState, id: string): boolean {
  return state.mounted.includes(id)
}
