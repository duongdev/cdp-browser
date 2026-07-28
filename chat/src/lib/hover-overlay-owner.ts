// Single-owner model for the hover overlays that float over a message row (PSN-105 L).
//
// The bug this replaces: every MessageRow owned an independent `reactHover` boolean plus its own
// hide timer, so "at most one reaction toolbar on screen" was an emergent property of hover events
// lining up — and they don't. Brushing the pointer across three rows spawned three toolbars, and a
// row that lost its mouseleave (scroll under a still cursor, pointer off the window, row unmounting
// mid-hover) left one abandoned.
//
// So ownership is explicit and lives here: ONE id owns the overlay at a time, by construction —
// claiming for a new id evicts the previous one in the same call. Pure (DI'd timers), so the delay
// policy is testable without a DOM. The React binding + the window-level guards live in
// use-hover-overlay.ts; the store itself knows nothing about the DOM.
//
// Delay policy:
//  - Opening always waits `openDelay`, so brushing past a row never spawns a toolbar — even when
//    another overlay is already up. Previously a row-to-row swap was instant, which let a brush past
//    an adjacent bubble yank ownership from a bar the user was actively moving toward (PSN-113 D).
//  - Leaving waits `closeDelay`, the grace window that lets the cursor cross the anchor→content gap.
//  - A locked owner (its emoji catalog is open) can't be evicted or closed by hover at all; only an
//    authoritative dismissal (`release` on blur / conversation switch / unmount) takes it down.

export interface HoverOverlayOptions {
  /** Dwell before an overlay appears when none is open. Default 180ms. */
  openDelay?: number
  /** Grace before an overlay disappears after the pointer leaves. Default 300ms. */
  closeDelay?: number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export interface HoverOverlayOwner {
  /** The id currently showing an overlay, or null. */
  owner(): string | null
  subscribe(listener: () => void): () => void
  /** Pointer entered `id` — open after the delay (even if another overlay is already up). */
  requestOpen(id: string): void
  /** Pointer left `id` — close after the grace delay. */
  requestClose(id: string): void
  /** Pin/unpin the overlay for `id` (its picker is open). A locked owner survives hover changes. */
  setLocked(id: string, locked: boolean): void
  /** Authoritative teardown for `id`: unmount, window blur, conversation switch. No-op for a
   *  non-owner, so a row mounting (pagination, a new message) can never steal another row's bar. */
  release(id: string): void
  /** Close whoever owns it unless they're locked — for events with no row context (the pointer
   *  leaving the window, the thread scrolling under a stationary cursor). */
  closeUnlessLocked(): void
}

export function createHoverOverlayOwner(opts: HoverOverlayOptions = {}): HoverOverlayOwner {
  const openDelay = opts.openDelay ?? 180
  const closeDelay = opts.closeDelay ?? 300
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))

  let ownerId: string | null = null
  let lockedId: string | null = null
  let pending: unknown = null
  const listeners = new Set<() => void>()

  const cancelPending = () => {
    if (pending !== null) {
      clearTimer(pending)
      pending = null
    }
  }
  const set = (next: string | null) => {
    if (ownerId === next) return
    ownerId = next
    for (const l of listeners) l()
  }

  return {
    owner: () => ownerId,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    requestOpen(id) {
      if (lockedId !== null && lockedId !== id) return
      cancelPending()
      if (ownerId === id) return
      // Wait the open delay even when another overlay is already up. The old instant-swap let a
      // brush past an adjacent bubble evict a bar the user was actively moving toward; now the new
      // row only claims after the delay, and the old owner closes on its own grace — so there's
      // still never a window in which both are painted (PSN-113 D).
      pending = setTimer(() => {
        pending = null
        set(id)
      }, openDelay)
    },
    requestClose(id) {
      if (lockedId === id) return
      cancelPending()
      if (ownerId !== id) return
      pending = setTimer(() => {
        pending = null
        if (ownerId === id) set(null)
      }, closeDelay)
    },
    setLocked(id, locked) {
      if (locked) {
        cancelPending()
        lockedId = id
        set(id)
        return
      }
      if (lockedId !== id) return
      lockedId = null
      // Unlocking is not "keep it forever": the pointer may be nowhere near it (a picker dismissed
      // by Escape). Fall back to the normal grace close; a cursor still on the bar re-opens it on
      // its next move.
      this.requestClose(id)
    },
    release(id) {
      if (ownerId !== id && lockedId !== id) return
      cancelPending()
      if (lockedId === id) lockedId = null
      set(null)
    },
    closeUnlessLocked() {
      if (lockedId !== null) return
      cancelPending()
      set(null)
    },
  }
}
