/**
 * The settings drawer's mouse-leave auto-close decision (t049).
 *
 * The drawer is loved on a Mac trackpad: flick the cursor off the panel and it
 * dismisses. On an iPad finger that same behavior is a trap — a touch synthesizes
 * a `mouseleave` the instant the finger lifts, so the drawer would close out from
 * under the reader. The fix gates the leave-timer strictly behind a *fine* pointer;
 * a coarse pointer dismisses via the header close (X) button or a scrim tap instead.
 *
 * Pure: read `pointerFine` live (`matchMedia("(pointer: fine)").matches`) per leave
 * event so detaching the Magic Keyboard flips to the coarse branch with no reload.
 */
export function shouldArmLeaveTimer(opts: {
  /** matchMedia("(pointer: fine)").matches, read at leave time — not cached at mount. */
  pointerFine: boolean
  /** Keyboard-opened / promoted drawer never auto-closes. */
  committed: boolean
  /** A portaled Select is open; the cursor is legitimately off-panel. */
  selectOpen: boolean
}): boolean {
  return opts.pointerFine && !opts.committed && !opts.selectOpen
}
