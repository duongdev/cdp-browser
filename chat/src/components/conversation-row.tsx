import { NotificationOff03Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { useEffect, useRef } from "react"
import { cn } from "@/lib/utils"
import { conversationLabel, isUnread, previewLine, relativeTime } from "../lib/conversation-view"
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
  const unread = isUnread(conversation)
  const muted = !!conversation.muted
  const labels = conversation.labels ?? []
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
        muted && "opacity-60",
      )}
      onClick={() => onOpen(conversation)}
      ref={ref}
      type="button"
    >
      <UserAvatar label={label} userId={conversation.avatarUserId} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5">
            <span
              className={cn("truncate text-foreground", unread ? "font-semibold" : "font-medium")}
            >
              {label}
            </span>
            {labels.map((l) => (
              <span
                className="shrink-0 rounded-full bg-muted px-1.5 py-px font-medium text-[10px] text-muted-foreground"
                key={l}
              >
                {l}
              </span>
            ))}
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            {time && <span className="font-mono text-xs text-muted-foreground">{time}</span>}
            {muted ? (
              <HugeiconsIcon
                aria-label="Muted"
                className="size-3.5 text-muted-foreground"
                icon={NotificationOff03Icon}
              />
            ) : (
              unread && (
                <span
                  aria-label="Unread"
                  className="size-2 rounded-full bg-ring"
                  role="img"
                  title="Unread"
                />
              )
            )}
          </span>
        </span>
        <span
          className={cn(
            "mt-0.5 block truncate text-sm",
            unread ? "text-foreground/80" : "text-muted-foreground",
          )}
        >
          {previewLine(conversation)}
        </span>
      </span>
    </button>
  )
}
