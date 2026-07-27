// Per-session model picker (t177), Copilot-chat placement: a compact control in the prompt-input
// footer — active model label + chevron opening the curated model list. Selection persists on the
// session (PATCH) and applies from the NEXT turn (no mid-stream switch). Four states: loading
// (disabled, default label), empty/single (hidden), error (hidden), populated.

import { ArrowDown01Icon, Tick01Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { useState } from "react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import type { AssistantModel } from "../../lib/assistant-client"

export function ModelSelector({
  models,
  sessionModel,
  onPick,
}: {
  /** null = still loading; [] = fetch failed or nothing configured (hidden). */
  models: AssistantModel[] | null
  /** The session's stored model override; null = env default. */
  sessionModel: string | null
  onPick: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  // Hidden only when nothing is configured. A SINGLE curated model still renders (steering): the
  // selector is how you see which model answers, and a hidden control reads as a missing feature.
  if (models !== null && models.length === 0) return null
  const def = models?.find((m) => m.default) ?? models?.[0]
  const activeId =
    sessionModel && models?.some((m) => m.id === sessionModel) ? sessionModel : def?.id
  const activeLabel = models?.find((m) => m.id === activeId)?.label ?? def?.label ?? "model"
  // A stored id no longer in the curated list falls back to the default — say so, non-blocking.
  const stale = !!sessionModel && models !== null && !models.some((m) => m.id === sessionModel)
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <button
          aria-label="Model"
          className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-muted-foreground text-xs hover:bg-accent hover:text-foreground disabled:opacity-50"
          disabled={models === null}
          type="button"
        >
          <span className="max-w-40 truncate">{activeLabel}</span>
          <HugeiconsIcon className="size-3" icon={ArrowDown01Icon} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-1" side="top">
        {stale && (
          <p className="px-2 py-1 text-muted-foreground text-xs">
            Saved model isn't available — using the default.
          </p>
        )}
        {(models ?? []).map((m) => (
          <button
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent",
              m.id === activeId && "bg-accent/60",
            )}
            key={m.id}
            onClick={() => {
              setOpen(false)
              onPick(m.id)
            }}
            type="button"
          >
            <span className="min-w-0 flex-1 truncate">{m.label}</span>
            {m.default && <span className="text-muted-foreground text-xs">default</span>}
            {m.id === activeId && <HugeiconsIcon className="size-3.5" icon={Tick01Icon} />}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}
