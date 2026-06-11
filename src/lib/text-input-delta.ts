// On-screen-keyboard text delta (t084). The screencast keyboard bridge holds a hidden
// field that the iOS keyboard edits; on every `input` we diff the field against its last
// value and forward the change to the remote page. Diffing (not per-keystroke capture) is
// what makes autocorrect, predictive text, paste, and composing input (Vietnamese Telex,
// CJK IME) work — the field holds the composed result and we sync the delta.
//
// The delta is the minimal "delete N from the end, then insert S" that turns prev → next,
// computed from the common prefix. That matches how a remote text cursor at the end edits:
// backspace the changed tail, type the new tail. Pure.

export interface InputDelta {
  /** Backspaces to send before inserting (chars removed from prev's tail). */
  backspaces: number
  /** Text to insert after the backspaces. */
  insert: string
}

export function diffInput(prev: string, next: string): InputDelta {
  if (prev === next) return { backspaces: 0, insert: "" }
  // Longest common prefix.
  let i = 0
  const max = Math.min(prev.length, next.length)
  while (i < max && prev[i] === next[i]) i++
  return { backspaces: prev.length - i, insert: next.slice(i) }
}
