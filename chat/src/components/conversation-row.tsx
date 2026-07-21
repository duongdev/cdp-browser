import { cn } from "@/lib/utils"
import { conversationLabel, previewLine, relativeTime } from "../lib/conversation-view"
import type { TeamsConversation } from "../lib/teams-client"

interface ConversationRowProps {
  conversation: TeamsConversation
  onOpen: (convId: string) => void
}

/** One conversation entry: avatar initial + label + last-message preview + relative time. */
export function ConversationRow({ conversation, onOpen }: ConversationRowProps) {
  const label = conversationLabel(conversation)
  const time = relativeTime(conversation.lastMessageTs)

  return (
    <button
      className={cn(
        "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors",
        "hover:bg-muted focus-visible:bg-muted focus-visible:outline-none",
      )}
      onClick={() => onOpen(conversation.id)}
      type="button"
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-medium text-primary">
        {label.charAt(0).toUpperCase()}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className="truncate font-medium text-foreground">{label}</span>
          {time && <span className="shrink-0 font-mono text-xs text-muted-foreground">{time}</span>}
        </span>
        <span className="mt-0.5 block truncate text-sm text-muted-foreground">
          {previewLine(conversation)}
        </span>
      </span>
    </button>
  )
}
