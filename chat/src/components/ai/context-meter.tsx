// Circular context-window meter (steering): an SVG ring in the composer card's footer with a
// shadcn Tooltip spelling out the estimate. Same chars/4 estimate the server compacts on (t173),
// so the ring and the backend's 40K budget agree.

import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

const SIZE = 18
const STROKE = 2.5
const R = (SIZE - STROKE) / 2
const CIRCUMFERENCE = 2 * Math.PI * R

/** 200000 → "200K", 8192 → "8,192" — exact when it isn't a round thousand. */
function formatTokens(n: number): string {
  return n >= 1000 && n % 1000 === 0 ? `${n / 1000}K` : n.toLocaleString()
}

export function ContextMeter({
  pct,
  budgetTokens,
  exact = true,
}: {
  pct: number
  budgetTokens: number
  /** False when the provider didn't report a window and this is the compaction fallback — the
   *  tooltip says so instead of implying it's the model's real limit. */
  exact?: boolean
}) {
  const clamped = Math.min(100, Math.max(0, pct))
  const high = clamped >= 80
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={`Context window ${clamped}% used`}
          className="gap-1.5 px-1.5 text-muted-foreground text-xs"
          size="sm"
          variant="ghost"
        >
          <svg
            aria-hidden="true"
            // The explicit `size-` keeps the Button's icon-sizing rule off the ring.
            className="-rotate-90 size-[18px]"
            height={SIZE}
            role="presentation"
            viewBox={`0 0 ${SIZE} ${SIZE}`}
            width={SIZE}
          >
            <circle
              // Track reads against the hover fill too — `muted` matched the old hover background
              // and the ring vanished on hover (steering).
              className="text-border"
              cx={SIZE / 2}
              cy={SIZE / 2}
              fill="none"
              r={R}
              stroke="currentColor"
              strokeWidth={STROKE}
            />
            <circle
              className={cn(
                "transition-[stroke-dashoffset] duration-300",
                high ? "text-destructive" : "text-ring",
              )}
              cx={SIZE / 2}
              cy={SIZE / 2}
              fill="none"
              r={R}
              stroke="currentColor"
              strokeDasharray={CIRCUMFERENCE}
              strokeDashoffset={CIRCUMFERENCE * (1 - clamped / 100)}
              strokeLinecap="round"
              strokeWidth={STROKE}
            />
          </svg>
          <span className="tabular-nums">{clamped}%</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {clamped}% of {formatTokens(budgetTokens)} tokens
        {exact ? "" : " (est.)"}
      </TooltipContent>
    </Tooltip>
  )
}
