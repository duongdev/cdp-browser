/** Pure layout logic for the composer toolbar.
 *
 * Two breakpoints, both measured on the composer card via a single ResizeObserver:
 *   ≥ FORMAT_INLINE_MIN_WIDTH (480) — format cluster sits inline in the footer row
 *   ≥ ACTIONS_INLINE_MIN_WIDTH (360) — action buttons (attach/emoji/GIF/sticker) sit inline
 *
 * Below ACTIONS_INLINE_MIN_WIDTH the actions collapse into a ⋯ DropdownMenu.
 * Send and the Aa format toggle stay visible at every width.
 *
 * Breakpoint derivation:
 *   Default layout: list 320px + AI panel 380px + thread flex-1; at a 1280px window the
 *   thread column is 580px and the composer card ≈ 548px — both clusters inline.
 *   When the AI panel is at its drag-max (640px) and the list is at its default (320px),
 *   a 1280px window yields a 320px thread → composer card ≈ 288px.  At 288px the four
 *   action buttons (4 × ~32px) plus dividers plus Aa plus send = ~230px; it fits, but
 *   tightly enough that adding even one more button would clip.  360px gives a comfortable
 *   40px cushion and is the natural "portrait phone" threshold where the row starts to feel
 *   cramped with four icon buttons plus two separators.
 */

export const FORMAT_INLINE_MIN_WIDTH = 480
export const ACTIONS_INLINE_MIN_WIDTH = 360

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
