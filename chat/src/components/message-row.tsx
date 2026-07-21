import { cn } from "@/lib/utils"
import { relativeTime } from "../lib/conversation-view"
import type { TeamsMessage } from "../lib/teams-client"

interface MessageRowProps {
  message: TeamsMessage
}

/** One message bubble. Own messages align right with the accent; others align left with the
 *  sender name. `body` is server-sanitized plain text rendered as a text node (never innerHTML). */
export function MessageRow({ message }: MessageRowProps) {
  const { self, deleted } = message
  const time = relativeTime(message.ts)

  return (
    <div className={cn("flex flex-col gap-0.5", self ? "items-end" : "items-start")}>
      {!self && (
        <span className="px-1 font-medium text-muted-foreground text-xs">{message.senderName}</span>
      )}
      <div
        className={cn(
          "max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-snug [overflow-wrap:anywhere] whitespace-pre-wrap",
          self ? "bg-primary text-primary-foreground" : "bg-muted text-foreground",
          deleted && "italic opacity-70",
        )}
      >
        {message.body}
      </div>
      <span className="px-1 font-mono text-[10px] text-muted-foreground">
        {time}
        {message.edited && !deleted && <span className="ml-1">(edited)</span>}
      </span>
    </div>
  )
}
