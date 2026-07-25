import { WifiOff01Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { cn } from "@/lib/utils"

interface ConnectionStatusProps {
  online: boolean
  className?: string
}

/** Sidebar-bottom status strip (C3). Shown only when offline; reserved-height so it doesn't
 *  overlap the last list row. Structure is intentionally generic — add more status variants here. */
export function ConnectionStatus({ online, className }: ConnectionStatusProps) {
  if (online) return null
  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-1.5 border-border/50 border-t bg-muted/60 px-3 py-2 text-muted-foreground text-xs",
        className,
      )}
    >
      <HugeiconsIcon className="size-3.5 shrink-0" icon={WifiOff01Icon} />
      Reconnecting…
    </div>
  )
}
