// Pure command registry for the chat ⌘K palette + `?` shortcut overlay (t152). Mirrors the `/`
// build's src/lib/hotkey-registry.ts: an action is plain data, effects are injected by chat-app.tsx
// (each `run` points at an existing handler), and the same list feeds both the palette and overlay.
//
// Context-aware: an action's optional `when(ctx)` gates its visibility on the current view + focus.
// The palette rebuilds its list from context on every open, so it only ever shows actions that work
// right now. Pure: no React, no DOM, no fetch.
import { fold } from "@/lib/fold-text"

/** The overlay categories, in display order. The `?` overlay renders these top-down. */
export const OVERLAY_GROUPS = ["Navigation", "Conversation", "Message", "App"] as const

export type ActionGroup = (typeof OVERLAY_GROUPS)[number]

/** What the palette/keys know about the current UI. Fed by chat-app.tsx. */
export interface ChatContext {
  view: "list" | "thread"
  /** The focused conversation in the list (keyboard cursor), or the open thread's id. */
  focusedConversationId?: string | null
  /** The focused message in the open thread (keyboard cursor), or null. */
  focusedMessageId?: string | null
  /** Whether the focused message is the viewer's own (gates edit/delete/…). */
  isOwnMessage?: boolean
  /** True while a text field / contenteditable holds focus — bare-key actions must not fire. */
  composerFocused?: boolean
}

export interface ChatAction {
  id: string
  label: string
  group: ActionGroup
  /** Display hint for the shortcut, e.g. "⌘K" or "j". Drives the palette hint + overlay row; an
   *  action without one shows no hint and is absent from the overlay. */
  keys?: string
  /** Visibility predicate. Absent → always available. */
  when?: (ctx: ChatContext) => boolean
  run: () => void
}

/** Entries may be falsy so callers can splice conditionally without pre-filtering. */
export type ChatActionInput = ChatAction | false | null | undefined

/** Build the concrete action list, dropping falsy entries. Fresh array, input untouched,
 *  registration order preserved (the palette + overlay rely on it). */
export function buildActions(input: ReadonlyArray<ChatActionInput>): ChatAction[] {
  return input.filter((a): a is ChatAction => Boolean(a))
}

/** Keep only the actions whose `when(ctx)` allows them in this context (no predicate → kept). */
export function actionsForContext(
  actions: ReadonlyArray<ChatAction>,
  ctx: ChatContext,
): ChatAction[] {
  return actions.filter((a) => !a.when || a.when(ctx))
}

/** Diacritic-safe fuzzy filter over the label (via fold-text). An empty/whitespace query returns
 *  the list unchanged (same reference); a non-matching query returns []. A "fuzzy" match = every
 *  query char appears in order (subsequence), so "jtc" matches "Jump to conversation". */
export function filterActions(actions: ReadonlyArray<ChatAction>, query: string): ChatAction[] {
  const q = fold(query.trim())
  if (!q) return actions as ChatAction[]
  return actions.filter((a) => subsequence(q, fold(a.label)))
}

function subsequence(needle: string, haystack: string): boolean {
  let i = 0
  for (let j = 0; j < haystack.length && i < needle.length; j++) {
    if (haystack[j] === needle[i]) i++
  }
  return i === needle.length
}

/** Partition into the overlay categories, preserving registration order. Only actions with a `keys`
 *  hint appear (the overlay is a shortcut reference). Every group key is present (empty array when
 *  nothing lands in it) so the overlay renders a stable layout. */
export function groupForOverlay(
  actions: ReadonlyArray<ChatAction>,
): Record<ActionGroup, ChatAction[]> {
  const out = Object.fromEntries(OVERLAY_GROUPS.map((g) => [g, [] as ChatAction[]])) as Record<
    ActionGroup,
    ChatAction[]
  >
  for (const a of actions) {
    if (a.keys) out[a.group].push(a)
  }
  return out
}
