// The one composer card both surfaces render inside (PSN-104 steering): the thread composer and
// the AI panel's prompt input. Owning the frame here is what keeps the two identical — same
// radius, border, shadow, focus ring, outer padding, and resting height. Neither caller restates
// any of it; a change lands on both at once.
//
// The INNER text surface (Tiptap editor vs textarea) stays with each caller — only their shared
// metrics live here, as the `.composer-editor, .ai-composer-input` rule in index.css.

import type { ReactNode, Ref } from "react"
import { cn } from "@/lib/utils"

/** Outer spacing around the card. Identical on both surfaces so the cards sit on the same row. */
const COMPOSER_OUTER = "shrink-0 px-3 pt-1 pb-[max(0.75rem,env(safe-area-inset-bottom))]"

/** The action row at the bottom of a composer card. Shared so both cards are the same height in
 *  their resting state (a textarea is inline-block by default — `block` kills the baseline gap
 *  that otherwise made the AI card 9px taller than the thread's). */
export const COMPOSER_FOOTER = "flex min-h-[2.3125rem] items-center gap-1.5 px-2 pb-2"

/** The card frame: idle border + the focus-within ring/shadow both composers share. */
const COMPOSER_CARD = cn(
  "relative rounded-2xl border border-input bg-card shadow-sm transition-shadow",
  "focus-within:border-ring/40 focus-within:shadow-md focus-within:ring-2 focus-within:ring-ring/25",
)

export function ComposerShell({
  children,
  cardRef,
  className,
}: {
  children: ReactNode
  /** The card element — the thread composer measures it for its width-responsive toolbar. */
  cardRef?: Ref<HTMLDivElement>
  className?: string
}) {
  return (
    <div className={COMPOSER_OUTER}>
      <div className={cn(COMPOSER_CARD, className)} ref={cardRef}>
        {children}
      </div>
    </div>
  )
}
