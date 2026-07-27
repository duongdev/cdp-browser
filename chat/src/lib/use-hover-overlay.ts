// React binding for the single-owner hover overlay (PSN-105 L). The policy lives in the pure
// hover-overlay-owner store; this file is only the wiring: one process-wide store instance, the two
// window-level guards a row's own mouseleave can never cover, and the hook a row uses.

import { useCallback, useEffect, useSyncExternalStore } from "react"
import { createHoverOverlayOwner } from "./hover-overlay-owner"

/** The one owner for every hover overlay on the page — the invariant is "one instance", not "one
 *  boolean per row". */
export const hoverOverlay = createHoverOverlayOwner()

// The one dismissal no row can see for itself, installed once: the pointer leaving the window
// entirely. It spares a locked overlay (an open emoji catalog stays put).
//
// Deliberately NOT here: a scroll guard. Measured (Playwright, Chrome) — the browser re-evaluates
// the hover chain when the thread scrolls under a stationary cursor, so the row's own mouseleave
// already fires and closes the bar. A window scroll listener was redundant and had a real cost: it
// killed the bar on scrolls that have nothing to do with the thread.
// Also not here: window blur / visibility / conversation switch. Those stay with the row
// (useDismissOnHidden → release) so a row MOUNTING can never tear down another row's overlay.
if (typeof window !== "undefined") {
  document.addEventListener("mouseleave", () => hoverOverlay.closeUnlessLocked())
}

export interface HoverOverlayHandle {
  /** True only while THIS id owns the overlay. */
  open: boolean
  /** Pointer entered the anchor (or the overlay content). */
  onEnter: () => void
  /** Pointer left the anchor (or the overlay content). */
  onLeave: () => void
  /** Authoritative teardown for this id (blur, conversation switch). */
  close: () => void
}

/**
 * Claim the shared hover overlay for `id`.
 * `enabled` false (coarse pointer, nothing to react to) → inert, never claims.
 * `locked` true (this row's emoji catalog is open) → the overlay is pinned open until it clears.
 */
export function useHoverOverlay(id: string, enabled: boolean, locked = false): HoverOverlayHandle {
  const owned = useSyncExternalStore(
    hoverOverlay.subscribe,
    () => hoverOverlay.owner() === id,
    () => false,
  )
  const onEnter = useCallback(() => {
    if (enabled) hoverOverlay.requestOpen(id)
  }, [enabled, id])
  const onLeave = useCallback(() => hoverOverlay.requestClose(id), [id])
  const close = useCallback(() => hoverOverlay.release(id), [id])

  // A row unmounting mid-hover (pagination, a poll dropping an optimistic bubble) would otherwise
  // leave the store pointing at an id that no longer paints anything.
  useEffect(() => close, [close])

  useEffect(() => {
    if (enabled) hoverOverlay.setLocked(id, locked)
  }, [enabled, id, locked])

  return { open: enabled && owned, onEnter, onLeave, close }
}
