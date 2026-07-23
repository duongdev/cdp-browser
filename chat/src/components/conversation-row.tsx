import { useEffect, useRef } from "react"
import { cn } from "@/lib/utils"
import { conversationLabel, previewLine, relativeTime } from "../lib/conversation-view"
import type { TeamsConversation } from "../lib/teams-client"
import { UserAvatar } from "./user-avatar"

interface ConversationRowProps {
  conversation: TeamsConversation
  onOpen: (conversation: TeamsConversation) => void
  active?: boolean
  /** Keyboard cursor (t152): draws the coral --ring + scrolls into view. Distinct from `active`
   *  (the open thread) — the keyboard cursor can hover a row before Enter opens it. */
  focused?: boolean
}

/** One conversation entry: avatar initial + label + last-message preview + relative time. */
export function ConversationRow({ conversation, onOpen, active, focused }: ConversationRowProps) {
  const label = conversationLabel(conversation)
  const time = relativeTime(conversation.lastMessageTs)
  const ref = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "nearest" })
  }, [focused])

  return (
    <button
      className={cn(
        "conv-row flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors",
        "hover:bg-muted focus-visible:bg-muted focus-visible:outline-none",
        active && "bg-muted",
        focused && "ring-2 ring-ring/70 ring-inset",
      )}
      onClick={() => onOpen(conversation)}
      ref={ref}
      type="button"
    >
      <UserAvatar label={label} userId={conversation.avatarUserId} />
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
