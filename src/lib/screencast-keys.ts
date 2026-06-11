// Pure key helpers for the on-screen keyboard bridge (t084/t086). Kept out of the
// component so the virtual-key-code mapping and the keydown routing are unit-testable —
// the t084 delete bug was a synthetic Backspace with no `keyCode`, which the remote
// silently ignored, so this is the part most worth pinning down with tests.

// Windows virtual key codes the remote's Input.dispatchKeyEvent needs for non-text keys.
export const VKEY: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Escape: 27,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46,
}

// Non-text keys forwarded straight from keydown (they emit no `input` event). Backspace is
// deliberately absent — it's routed by keyDownAction so in-field deletes ride the input
// delta and only an empty-field Backspace forwards from keydown (no double-delete).
export const KEYDOWN_KEYS = new Set([
  "Enter",
  "Tab",
  "Escape",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "Delete",
])

export interface SynthKey {
  key: string
  code: string
  keyCode: number
  altKey: false
  ctrlKey: false
  metaKey: false
  shiftKey: false
}

// The synthetic key event payload `RemotePage.forwardInput` turns into Input.dispatchKeyEvent.
// `keyCode` is the load-bearing field — a 0 here means the remote ignores the key.
export function synthKey(key: string): SynthKey {
  return {
    key,
    code: key,
    keyCode: VKEY[key] ?? 0,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
  }
}

export type KeyDownAction =
  | { type: "forward"; key: string } // forward this key, swallow the field event
  | { type: "ignore" } // let the field handle it (text/in-field delete → input delta)

// Decide what a keydown does. Backspace: forward only when the field is empty (otherwise
// the field shrinks and the input delta forwards the delete). Other non-text keys forward.
export function keyDownAction(key: string, fieldEmpty: boolean): KeyDownAction {
  if (key === "Backspace") return fieldEmpty ? { type: "forward", key } : { type: "ignore" }
  if (KEYDOWN_KEYS.has(key)) return { type: "forward", key }
  return { type: "ignore" }
}
