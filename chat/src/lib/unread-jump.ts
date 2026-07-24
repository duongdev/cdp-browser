/** Pure show/hide predicate for the "jump to unread" FAB. */
export interface UnreadJumpState {
  hasSeparator: boolean
  separatorSeen: boolean
  /** True when the separator's DOM rect is above the scroll container's visible area.
   *  In a flex-col-reverse scroller (scrollTop 0 = bottom/newest), "above" means the
   *  separator is in an older (higher-ts) zone the user hasn't scrolled up to yet. */
  separatorAboveViewport: boolean
}

export function shouldShowUnreadJump(s: UnreadJumpState): boolean {
  return s.hasSeparator && !s.separatorSeen && s.separatorAboveViewport
}
