// Tab lifecycle planner — turns "a Tab/Local Tab closed" or "a surface activated"
// into a directive. Composes Active Order (MRU across kinds), Closed Tabs (the
// reopen entry), and Pins (the pin-revert hint) so the close-fallback protocol
// lives in one tested place instead of being duplicated per kind in app.tsx.
//
// Pure: no React, no IPC, no DOM, no window. Returns new values; never mutates
// inputs. app.tsx owns every effect (close the target, swap the active surface,
// push the Closed Tabs entry, revert the Pin, persist).

import { type ActiveRef, dropActive, mostRecent, touchActive } from "./active-order"
import type { ClosedEntry } from "./closed-tabs"
import type { LocalTab } from "./local-tabs"
import { pinForTarget } from "./pins"

/** A visible CDP Tab in stable order (linked-to-pin tabs already filtered out). */
export interface VisibleTab {
  id: string
  url: string
}

export interface CloseInput {
  kind: "cdp" | "local"
  /** Closed Tab's targetId, or closed Local Tab's id. */
  id: string
  /** The closed Tab's URL, for the ClosedEntry. */
  url: string
  wasActive: boolean
  /** Active Order (MRU, oldest → newest) reflecting the world before the close. */
  order: ActiveRef[]
  /** Visible CDP Tabs after the close, stable order; pin-held tabs excluded. */
  tabs: VisibleTab[]
  /** Local Tabs after the close, in their section order. */
  locals: LocalTab[]
  /** Pins, to detect one holding the closed CDP target. */
  pins: Pin[]
}

export interface CloseDirective {
  /** Push onto the Closed Tabs stack so Cmd+Shift+T reopens it in its kind. */
  closedEntry: ClosedEntry
  /** The surface to activate, or null. Disambiguated by `clearActive`. */
  nextActive: ActiveRef | null
  /**
   * Only meaningful when `nextActive` is null: `false` means "leave the current
   * Active Tab alone" (a non-active tab closed); `true` means "nothing left to
   * show — clear the active surface".
   */
  clearActive: boolean
  /** Present when the closed CDP Tab was held by a Pin — app.tsx reverts it. */
  revertPin?: Pin
}

/**
 * Decide what happens when a Tab or Local Tab closes: which Closed Tabs entry to
 * push, which surface to activate next (MRU across kinds, then first-visible
 * fallback), whether to clear the active surface entirely, and whether a Pin must
 * revert to unlinked.
 */
export function planClose(input: CloseInput): CloseDirective {
  const { kind, id, url, wasActive, order, tabs, locals, pins } = input

  const closedEntry: ClosedEntry = { kind, url }
  const revertPin = kind === "cdp" ? pinForTarget(pins, id) : undefined

  // A non-active tab closed: the active surface is untouched.
  if (!wasActive) {
    return { closedEntry, nextActive: null, clearActive: false, revertPin }
  }

  // Drop the just-closed surface from the MRU history, then pick the newest
  // still-open surface of either kind.
  const remainingOrder = dropActive(order, { kind, id })
  const openTabIds = new Set(tabs.map((t) => t.id))
  const openLocalIds = new Set(locals.map((t) => t.id))
  const isOpen = (e: ActiveRef) =>
    e.kind === "cdp" ? openTabIds.has(e.id) : openLocalIds.has(e.id)

  const mru = mostRecent(remainingOrder, isOpen)
  if (mru) {
    return { closedEntry, nextActive: { ...mru }, clearActive: false, revertPin }
  }

  // No MRU history left — fall back to the first visible Tab in stable order,
  // CDP first, then Local Tabs.
  if (tabs.length > 0) {
    return {
      closedEntry,
      nextActive: { kind: "cdp", id: tabs[0].id },
      clearActive: false,
      revertPin,
    }
  }
  if (locals.length > 0) {
    return {
      closedEntry,
      nextActive: { kind: "local", id: locals[0].id },
      clearActive: false,
      revertPin,
    }
  }

  // Nothing left to show.
  return { closedEntry, nextActive: null, clearActive: true, revertPin }
}

/**
 * Record a surface activation in the Active Order. A thin, named wrapper over
 * `touchActive` so the switch path and the close path read from the same
 * vocabulary; returns a new order with `ref` as most-recent, input unmutated.
 */
export function planSwitch(order: ActiveRef[], ref: ActiveRef): ActiveRef[] {
  return touchActive(order, ref)
}
