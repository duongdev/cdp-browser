// The attach tray (PSN-104 grill): everything the assistant can see for this session, as removable
// chips above the composer. There is no hidden scope any more — an empty tray means "search
// everything", so what you see here IS the context.
//
// Chips are typed: a chat chip carries the conversation title, a message chip carries
// "Sender: excerpt…" so two messages from the same conversation are distinguishable. Clicking a
// chip jumps to it in the main pane; ✕ detaches it.

import { Cancel01Icon, Message01Icon, MessageMultiple01Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { AssistantContextRef } from "../../lib/assistant-client"

/** The chip's visible label: a message shows who said what, a chat shows its title. */
export function chipLabel(ref: AssistantContextRef): string {
  if (ref.kind !== "message") return ref.title
  const who = ref.sender || "Message"
  return ref.preview ? `${who}: ${ref.preview}` : who
}

export function ContextTray({
  refs,
  onOpen,
  onRemove,
}: {
  refs: AssistantContextRef[]
  onOpen: (ref: AssistantContextRef) => void
  onRemove: (ref: AssistantContextRef) => void
}) {
  if (refs.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1 px-3 pb-1">
      {refs.map((r) => (
        <span
          // Inline chips so a label uses whatever width is free on the row and only truncates
          // against the tray edge — a fixed max-width left dead space beside short chips.
          className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border border-border bg-accent/50 py-0.5 pr-0.5 pl-2 text-muted-foreground text-xs"
          key={`${r.convId}:${r.msgId ?? ""}`}
        >
          <HugeiconsIcon
            className="size-3.5 shrink-0"
            icon={r.kind === "message" ? Message01Icon : MessageMultiple01Icon}
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className="min-w-0 truncate hover:text-foreground"
                onClick={() => onOpen(r)}
                type="button"
              >
                {chipLabel(r)}
              </button>
            </TooltipTrigger>
            <TooltipContent>
              {r.kind === "message" ? `Message in ${r.title}` : `Whole conversation: ${r.title}`}
            </TooltipContent>
          </Tooltip>
          <button
            aria-label={`Remove ${chipLabel(r)}`}
            className="flex size-5 shrink-0 items-center justify-center rounded-full hover:bg-accent hover:text-foreground"
            onClick={() => onRemove(r)}
            type="button"
          >
            <HugeiconsIcon className="size-3" icon={Cancel01Icon} />
          </button>
        </span>
      ))}
    </div>
  )
}
