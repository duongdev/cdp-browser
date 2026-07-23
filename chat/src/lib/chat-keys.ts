// Pure keydown → intent router for the chat app's keyboard-first navigation (t152). Mirrors the
// `/` build's src/lib/key-routing.ts split: this decides WHAT a keystroke means; chat-app.tsx runs
// the effect. No DOM, no React — `routeKey` is a plain function over a key-event shape + context.
//
// The hard guard: no BARE-char shortcut fires while a text field / contenteditable is focused (the
// composer, the inline edit box, the palette input, a search field). ⌘K and the modifier shortcuts
// are exempt (they must work from inside the composer). Esc is never claimed here — the palette,
// lightbox, and edit flows own Escape via their own handlers; routing it would fight them.
import type { ChatContext } from "./command-registry"

/** The subset of a KeyboardEvent this router reads. Lets tests pass a plain object. */
export interface KeyLike {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  /** The element that received the event; used to detect a text-editing target. */
  target?: EventTarget | null
}

/** The intents keyboard nav can produce. chat-app.tsx maps each to an effect. `go` is the second
 *  half of a two-key `g`-prefix sequence (chat-app tracks the pending `g`). */
export type KeyIntent =
  | { type: "focus-next" } // j / ↓
  | { type: "focus-prev" } // k / ↑
  | { type: "open" } // Enter — open focused conversation (list)
  | { type: "palette" } // ⌘K
  | { type: "overlay" } // ? or ⌘/
  | { type: "g-prefix" } // first key of a `g …` sequence
  | { type: "go-inbox" } // g then i
  | { type: "edit" } // e — edit focused own message
  | { type: "delete" } // ⌫ / Delete — delete focused own message
  | { type: "react" } // r — open reaction bar on focused message
  | { type: "toggle-read" } // u — toggle read/unread on the focused/open conversation

/** True when the event target is a text-editing surface (input/textarea/select/contenteditable).
 *  Bare-char shortcuts must be suppressed there so typing isn't hijacked. */
export function isEditableTarget(target: EventTarget | null | undefined): boolean {
  const el = target as HTMLElement | null
  if (!el || typeof el.tagName !== "string") return false
  const tag = el.tagName.toLowerCase()
  if (tag === "input" || tag === "textarea" || tag === "select") return true
  return el.isContentEditable === true
}

/** True while any modifier that would make a bare-char shortcut a real chord is held. Shift alone is
 *  allowed (`?` is Shift+/); Meta/Ctrl/Alt on a bare key is a different command, not our shortcut. */
function hasChordModifier(e: KeyLike): boolean {
  return e.metaKey || e.ctrlKey || e.altKey
}

/**
 * Route a keydown to an intent, or null to let it fall through. `pendingG` is true when the previous
 * keystroke was a `g` awaiting its second key (chat-app owns the 1s timeout that clears it).
 *
 * Order: modifier shortcuts (⌘K, ⌘/) first — they work everywhere, even in the composer. Then the
 * editable-target guard blocks every bare-char shortcut. Then the `g`-sequence, then the bare keys.
 */
export function routeKey(e: KeyLike, ctx: ChatContext, pendingG: boolean): KeyIntent | null {
  // ⌘K / Ctrl+K — palette. Works from anywhere (including the composer).
  if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) return { type: "palette" }
  // ⌘/ / Ctrl+/ — shortcut overlay. Also global.
  if ((e.metaKey || e.ctrlKey) && e.key === "/") return { type: "overlay" }

  // Everything below is a bare-key shortcut: suppressed in a text field / when a chord modifier is
  // held, and while the composer is focused (chat-app also passes composerFocused as a belt).
  if (isEditableTarget(e.target) || ctx.composerFocused || hasChordModifier(e)) return null

  // Two-key `g` sequence: a pending `g` + `i` → go to inbox/list. Any other key ends the sequence
  // (returns null → chat-app clears pendingG and re-routes nothing).
  if (pendingG) {
    if (e.key === "i") return { type: "go-inbox" }
    return null
  }
  if (e.key === "g") return { type: "g-prefix" }

  switch (e.key) {
    case "j":
    case "ArrowDown":
      return { type: "focus-next" }
    case "k":
    case "ArrowUp":
      return { type: "focus-prev" }
    case "Enter":
      // Open the focused conversation — only meaningful in the list.
      return ctx.view === "list" ? { type: "open" } : null
    case "?":
      return { type: "overlay" }
    case "e":
      return ctx.view === "thread" && ctx.isOwnMessage ? { type: "edit" } : null
    case "Backspace":
    case "Delete":
      return ctx.view === "thread" && ctx.isOwnMessage ? { type: "delete" } : null
    case "r":
      return ctx.view === "thread" && ctx.focusedMessageId ? { type: "react" } : null
    case "u":
      // Toggle read/unread on the focused (list) or open (thread) conversation.
      return ctx.focusedConversationId ? { type: "toggle-read" } : null
    default:
      return null
  }
}
