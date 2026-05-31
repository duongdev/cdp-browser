// Hotkey registry — the single source of truth shared by the ⌘K command palette and the
// `?` shortcut overlay. An Action is plain data: a name, a ux.md group, an optional hotkey
// display hint, and a `run` effect that app.tsx injects (it points at the *existing*
// handler — the same callback the keydown switch or a toolbar button already invokes, so
// the palette is presentation, never a second copy of the effect logic).
//
// Pure: no React, no IPC, no DOM, no `window`. It only builds and queries the action list.
// See docs/conventions/ux.md (command palette + `?` overlay + standard-shortcut tables).

/** The ux.md shortcut categories, in display order. The overlay renders these top-down. */
export const OVERLAY_GROUPS = ["Global", "Tab navigation", "Sidebar", "Address bar"] as const

export type ActionGroup = (typeof OVERLAY_GROUPS)[number]

export interface Action {
  id: string
  name: string
  group: ActionGroup
  /** Display string for the shortcut, e.g. "⌘R". Drives both the palette hint and the
   *  overlay row; an action without one shows no hint and is absent from the overlay. */
  hotkey?: string
  run: () => void
}

/** Entries may be falsy so callers can splice conditionally (`cond && action`) without
 *  pre-filtering — `buildActions` drops the holes and returns a fresh array. */
export type ActionInput = Action | false | null | undefined

/** Build the concrete action list, dropping falsy entries. Returns a new array; the input
 *  is never mutated. Registration order is preserved (the palette and overlay rely on it). */
export function buildActions(input: ReadonlyArray<ActionInput>): Action[] {
  return input.filter((a): a is Action => Boolean(a))
}

/** The display hint for an action's shortcut, or undefined when it has none. */
export function hotkeyHint(action: Action): string | undefined {
  return action.hotkey || undefined
}

/** Case-insensitive substring filter over name and group label. An empty/whitespace query
 *  returns the list unchanged (same reference); a non-matching query returns []. Pure. */
export function filterActions(actions: ReadonlyArray<Action>, query: string): Action[] {
  const q = query.trim().toLowerCase()
  if (!q) return actions as Action[]
  return actions.filter(
    (a) => a.name.toLowerCase().includes(q) || a.group.toLowerCase().includes(q),
  )
}

/** Partition actions into the ux.md categories for the `?` overlay, preserving
 *  registration order within each group. Only actions with a hotkey appear — the overlay
 *  is a shortcut reference, not a full command list. Every group key is always present
 *  (empty array when no action lands in it) so the overlay can render a stable layout. */
export function groupForOverlay(actions: ReadonlyArray<Action>): Record<ActionGroup, Action[]> {
  const out = Object.fromEntries(OVERLAY_GROUPS.map((g) => [g, [] as Action[]])) as Record<
    ActionGroup,
    Action[]
  >
  for (const a of actions) {
    if (a.hotkey) out[a.group].push(a)
  }
  return out
}
