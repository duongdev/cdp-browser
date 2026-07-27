/** Pure layout logic for the composer toolbar.
 *
 * Two breakpoints, both applied to the composer card's CONTENT width (the ResizeObserver
 * reports `contentRect`, i.e. the card minus its 1px borders — so these numbers are the
 * footer row's own available width, not the card's outer width):
 *   ≥ FORMAT_INLINE_MIN_WIDTH — format cluster sits inline in the footer row
 *   ≥ ACTIONS_INLINE_MIN_WIDTH — action buttons (attach/emoji/GIF/sticker) sit inline
 *
 * Below each, that cluster collapses (format → the Aa toggle, actions → a ⋯ DropdownMenu).
 * Send and the Aa/⋯ toggles stay visible at every width, so the row never wraps.
 *
 * Breakpoint derivation — MEASURED in Chrome against the real rendered footer, not guessed
 * (the previous 480/360 pair was guessed and wrapped the row at every width in 480…640):
 *
 *   both clusters inline   = 4 actions (28+28+56) + 4 dividers (4×9) + ToggleGroup (150)
 *                            + 7 format buttons (7×28) + send (28) + 17 gaps (17×6)
 *                            + px-2 padding (16)                              = 640px
 *   actions inline, format collapsed = actions (112) + Aa (28) + send (28)
 *                            + 6 gaps (36) + padding (16)                     = 220px
 *
 *   Verified live by driving the card width: at a 640px content width the footer is one
 *   37px row; at 620px it becomes two rows (65px).  Each constant adds a ~20px cushion so
 *   a slightly wider glyph or a different font metric can't tip it back over.
 *
 * Because format needs ~3× the width of actions, format is always the first to collapse —
 * there is deliberately no band where actions collapse while the format cluster is inline.
 */

/** Measured minimum content width for the fully inline footer row (see derivation above). */
export const FORMAT_INLINE_MEASURED = 640
/** Measured minimum content width for actions inline with the format cluster collapsed. */
export const ACTIONS_INLINE_MEASURED = 220
/** Slack against font/glyph-metric variance. */
const CUSHION = 20

export const FORMAT_INLINE_MIN_WIDTH = FORMAT_INLINE_MEASURED + CUSHION
export const ACTIONS_INLINE_MIN_WIDTH = ACTIONS_INLINE_MEASURED + CUSHION

export type ComposerLayout = {
  /** True when the format cluster (bold/italic/…) should be shown inline in the footer. */
  formatInline: boolean
  /** True when the action buttons (attach/emoji/GIF/sticker) should be shown inline. */
  actionsInline: boolean
}

/** Returns the layout for a given composer card width. */
export function composerLayoutFor(width: number): ComposerLayout {
  return {
    formatInline: width >= FORMAT_INLINE_MIN_WIDTH,
    actionsInline: width >= ACTIONS_INLINE_MIN_WIDTH,
  }
}
