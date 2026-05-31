/**
 * Find Bar — the pure find-state machine behind the in-page find overlay (t001).
 * Owns query / current-match / total / open-close; the effectful remote-page search
 * is enacted by the caller (`find-bar.tsx`), which feeds the reported `total` back in
 * via `setTotal`. No I/O — no `document`, no `window.find`, no transport, no timers.
 * Same pure-advisor / effectful-executor split as `tab-lifecycle.ts`.
 */

export interface FindState {
  open: boolean
  query: string
  /** 0-based; meaningless when `total === 0`. */
  currentIndex: number
  total: number
}

export type FindAction =
  | { type: "open" }
  | { type: "close" }
  | { type: "setQuery"; query: string }
  | { type: "setTotal"; total: number }
  | { type: "next" }
  | { type: "prev" }

export const closedFindState: FindState = {
  open: false,
  query: "",
  currentIndex: 0,
  total: 0,
}

export function reduce(state: FindState, action: FindAction): FindState {
  switch (action.type) {
    case "open":
      // Re-opening an open bar is a no-op here — the caller re-focuses/selects.
      return state.open ? state : { ...closedFindState, open: true }
    case "close":
      return closedFindState
    case "setQuery":
      // A new query invalidates the prior result; the count is pending until setTotal.
      return { ...state, query: action.query, currentIndex: 0, total: 0 }
    case "setTotal": {
      const total = Math.max(0, action.total)
      const currentIndex = total === 0 ? 0 : Math.min(state.currentIndex, total - 1)
      return { ...state, total, currentIndex }
    }
    case "next":
      if (state.total === 0) return state
      return { ...state, currentIndex: (state.currentIndex + 1) % state.total }
    case "prev":
      if (state.total === 0) return state
      return { ...state, currentIndex: (state.currentIndex - 1 + state.total) % state.total }
  }
}

/** "3/12" for matches, "0/0" for a non-empty no-match query, "" for an empty query. */
export function counterLabel(state: FindState): string {
  if (!state.query) return ""
  if (state.total === 0) return "0/0"
  return `${state.currentIndex + 1}/${state.total}`
}
