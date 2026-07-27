// Shimmering text for in-flight assistant states (steering; the animate-ui "shimmering text"
// primitive, reimplemented locally — a background-clip gradient sweeping across the glyphs, no new
// dependency). Honors prefers-reduced-motion via the `motion-reduce` variants.

import { cn } from "@/lib/utils"

export function ShimmerText({ children, className }: { children: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-block bg-[length:200%_100%] bg-clip-text text-transparent",
        "bg-[linear-gradient(110deg,var(--color-muted-foreground)_35%,var(--color-foreground)_50%,var(--color-muted-foreground)_65%)]",
        "animate-[chat-shimmer_2s_linear_infinite]",
        "motion-reduce:animate-none motion-reduce:bg-none motion-reduce:text-muted-foreground",
        className,
      )}
    >
      {children}
    </span>
  )
}
