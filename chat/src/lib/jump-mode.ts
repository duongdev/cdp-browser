// Pure jump-mode state for the thread pane (t175). While active, the pane shows a DB-served
// window around a cited message INSTEAD of the live newest page — live deltas are dropped (the
// window must never merge into the newest-page array) until load-newer walks forward and rejoins.

export interface JumpState {
  active: boolean
  /** The cited message the window centers on — highlighted on land. */
  targetId: string | null
  /** More DB pages exist below the window; false = the window reaches the newest synced message,
   *  so the pane can rejoin live mode. */
  hasNewer: boolean
}

export const JUMP_IDLE: JumpState = { active: false, targetId: null, hasNewer: false }

export function enterJump(targetId: string, hasNewer: boolean): JumpState {
  return { active: true, targetId, hasNewer }
}

/** Fold a load-newer page's flag. Reaching hasNewer=false does NOT auto-exit — the caller exits
 *  via `shouldRejoin` so the final page still renders from windowed state first. */
export function extendNewer(s: JumpState, hasNewer: boolean): JumpState {
  if (!s.active) return s
  return { ...s, hasNewer }
}

/** True when the window has caught up with the newest synced message — time to return to live
 *  mode (fresh newest page + deltas resume). */
export function shouldRejoin(s: JumpState): boolean {
  return s.active && !s.hasNewer
}
