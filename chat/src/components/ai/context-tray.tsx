// The attach tray (PSN-104 grill + steering): everything the assistant can see for this session,
// as removable chips above the composer. There is no hidden scope any more — an empty tray means
// "search everything", so what you see here IS the context.
//
// It sits directly above the prompt input, so it must never grow without bound: the tray is a
// COLLAPSIBLE header ("3 attached · 2 chats · 1 folder") over a chip list that is capped in height
// and scrolls. One or two chips stay expanded (they cost nothing); more collapse by default.
//
// Chips are typed: a chat chip carries the conversation title, a message chip carries
// "Sender: excerpt…" so two messages from the same conversation are distinguishable, and a
// folder/label chip carries the scope name. Clicking a conversation chip jumps to it; ✕ detaches.

import {
  ArrowRight01Icon,
  Cancel01Icon,
  Folder01Icon,
  Message01Icon,
  MessageMultiple01Icon,
  Tag01Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react"
import { useEffect, useRef, useState } from "react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { type AssistantContextRef, isScopeRef } from "../../lib/assistant-client"
import { defaultTrayOpen, summarizeRefs } from "../../lib/context-tray-view"

/** The chip's visible label: a message shows who said what, everything else shows its title. */
export function chipLabel(ref: AssistantContextRef): string {
  if (ref.kind !== "message") return ref.title
  const who = ref.sender || "Message"
  return ref.preview ? `${who}: ${ref.preview}` : who
}

function chipIcon(ref: AssistantContextRef): IconSvgElement {
  if (ref.kind === "folder") return Folder01Icon
  if (ref.kind === "label") return Tag01Icon
  return ref.kind === "message" ? Message01Icon : MessageMultiple01Icon
}

function chipTooltip(ref: AssistantContextRef): string {
  if (ref.kind === "folder") return `Everything in the folder "${ref.title}"`
  if (ref.kind === "label") return `Everything labelled "${ref.title}"`
  return ref.kind === "message" ? `Message in ${ref.title}` : `Whole conversation: ${ref.title}`
}

function refKeyOf(ref: AssistantContextRef): string {
  return isScopeRef(ref) ? `${ref.kind}:${ref.name}` : `${ref.convId}:${ref.msgId ?? ""}`
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
  const [open, setOpen] = useState(() => defaultTrayOpen(refs.length))
  // A fresh attach should be VISIBLE — expand when the tray grows, but never fight a manual
  // collapse of an unchanged list.
  const prevCount = useRef(refs.length)
  useEffect(() => {
    if (refs.length > prevCount.current) setOpen(true)
    prevCount.current = refs.length
  }, [refs.length])

  if (refs.length === 0) return null
  return (
    <div className="shrink-0 px-3 pb-1">
      <button
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 rounded-md py-1 text-left text-muted-foreground text-xs hover:text-foreground"
        onClick={() => setOpen((v) => !v)}
        type="button"
      >
        {/* Same disclosure idiom as the sidebar's folder headers: points right when collapsed,
            down when open. */}
        <HugeiconsIcon
          className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")}
          icon={ArrowRight01Icon}
        />
        <span className="shrink-0 font-medium">{refs.length} attached</span>
        <span className="min-w-0 truncate opacity-70">{summarizeRefs(refs)}</span>
      </button>
      {open && (
        // Capped + scrollable: the composer never gets pushed off the panel by a long attach list.
        <div className="flex max-h-24 flex-wrap gap-1 overflow-y-auto overscroll-contain">
          {refs.map((r) => (
            <span
              // Inline chips so a label uses whatever width is free on the row and only truncates
              // against the tray edge — a fixed max-width left dead space beside short chips.
              className="inline-flex min-w-0 max-w-full items-center gap-1 self-start rounded-full border border-border bg-accent/50 py-0.5 pr-0.5 pl-2 text-muted-foreground text-xs"
              key={refKeyOf(r)}
            >
              <HugeiconsIcon className="size-3.5 shrink-0" icon={chipIcon(r)} />
              <Tooltip>
                <TooltipTrigger asChild>
                  {/* A scope has nowhere to jump to — it's a name, not a conversation. */}
                  {isScopeRef(r) ? (
                    <span className="min-w-0 truncate">{chipLabel(r)}</span>
                  ) : (
                    <button
                      className="min-w-0 truncate hover:text-foreground"
                      onClick={() => onOpen(r)}
                      type="button"
                    >
                      {chipLabel(r)}
                    </button>
                  )}
                </TooltipTrigger>
                <TooltipContent>{chipTooltip(r)}</TooltipContent>
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
      )}
    </div>
  )
}
