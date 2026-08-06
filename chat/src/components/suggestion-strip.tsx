// Reply suggestions strip (ADR-0027, PSN-143). Sits above the composer and shows the candidate
// replies an agent wrote for this thread.
//
// The one rule this component exists to keep: clicking a suggestion INSERTS it into the composer.
// It never sends. The user edits it and presses Send himself — that difference is the whole reason
// this phase exists, and there is deliberately no send path in this file to drift.
//
// Presentational only: the batch, the request lifecycle, and the generate action live in
// `useReplySuggestions`, because the generate button renders in the composer toolbar, not here.

import { AlertCircleIcon, Cancel01Icon, SparklesIcon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { stripMode } from "../lib/suggestion-strip-view"
import type { ReplySuggestions } from "../lib/use-reply-suggestions"
import { ShimmerText } from "./ai/shimmer-text"

interface SuggestionStripProps {
  /** The shared controller — also drives the composer's generate button. */
  suggestions: ReplySuggestions
  /** The newest message id in the thread; a batch written for an older one is stale. */
  latestMsgId: string | null
  /** Insert text into the composer. Wired to the t176 `insertDraft` path by thread-view. */
  onInsert: (text: string) => void
}

export function SuggestionStrip({ suggestions, latestMsgId, onInsert }: SuggestionStripProps) {
  const { batch, pending, error, choose, dismiss } = suggestions
  // All display precedence lives in `stripMode` (pure, unit-tested) so this component only maps a
  // decision to markup.
  const mode = stripMode({ batch, pending, error, latestMsgId })

  // Nothing to show: render nothing at all. The generate affordance lives in the composer toolbar,
  // so an empty strip here would be a container with no purpose.
  if (mode.kind === "idle") return null

  return (
    <div className="flex shrink-0 flex-col gap-1.5 px-3 pt-2 pb-1">
      <div className="flex items-center gap-1.5 text-muted-foreground text-xs">
        <HugeiconsIcon className="size-3.5" icon={SparklesIcon} />
        {mode.kind === "busy" || (mode.kind === "batch" && mode.busy) ? (
          <ShimmerText>Writing suggestions…</ShimmerText>
        ) : (
          <span>Suggested replies</span>
        )}
        {mode.kind === "batch" && mode.stale && !mode.busy && (
          <span
            className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-600 dark:text-amber-400"
            title="Written before the newest message in this thread"
          >
            stale
          </span>
        )}
        {mode.kind === "batch" && (
          <Button
            aria-label="Dismiss suggestions"
            className="ml-auto size-6 text-muted-foreground"
            onClick={dismiss}
            size="icon-sm"
            variant="ghost"
          >
            <HugeiconsIcon className="size-3.5" icon={Cancel01Icon} />
          </Button>
        )}
      </div>

      {mode.kind === "error" && (
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <HugeiconsIcon className="size-3.5 shrink-0" icon={AlertCircleIcon} />
          <span>{mode.message}</span>
        </div>
      )}

      {mode.kind === "batch" && (
        <div className="flex flex-wrap gap-1.5">
          {mode.texts.map((text, idx) => (
            <button
              className={cn(
                "max-w-full truncate rounded-full border border-border bg-muted/40 px-3 py-1.5 text-left text-xs",
                "hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                mode.chosenIdx === idx && "border-primary/60 bg-primary/10",
              )}
              // Inserts into the composer. Does not send — see the header comment.
              // Keyed by batch id + text, not index: a regenerate reuses indices, so an index key
              // would let React keep the old DOM node (and its focus ring) for new content.
              key={`${batch?.id}-${text}`}
              onClick={() => {
                const picked = choose(idx)
                if (picked !== null) onInsert(picked)
              }}
              title={text}
              type="button"
            >
              {text}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
