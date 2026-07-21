import { cn } from "@/lib/utils"
import { relativeTime } from "../lib/conversation-view"
import { sanitize } from "../lib/sanitize-message"
import type { TeamsMessage } from "../lib/teams-client"

interface MessageRowProps {
  message: TeamsMessage
}

/** One message bubble. Own messages align right with the accent; others align left with the
 *  sender name. `body` is rich, site-authored HTML (t111) — bold/links/mentions/emoji/code/lists. */
export function MessageRow({ message }: MessageRowProps) {
  const { self, deleted } = message
  const time = relativeTime(message.ts)

  return (
    <div className={cn("flex flex-col gap-0.5", self ? "items-end" : "items-start")}>
      {!self && (
        <span className="px-1 font-medium text-muted-foreground text-xs">{message.senderName}</span>
      )}
      {/* XSS BOUNDARY: message.body is site-authored HTML. It MUST pass through sanitize() (DOMPurify,
          strict allowlist) before it hits the DOM — never render body raw. This is the only guard. */}
      <div
        className={cn(
          "teams-message-body max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-snug [overflow-wrap:anywhere]",
          self ? "bg-primary text-primary-foreground" : "bg-muted text-foreground",
          deleted && "italic opacity-70",
        )}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitize() is the XSS boundary (t111)
        dangerouslySetInnerHTML={{ __html: sanitize(message.body) }}
      />
      <span className="px-1 font-mono text-[10px] text-muted-foreground">
        {time}
        {message.edited && !deleted && <span className="ml-1">(edited)</span>}
      </span>
    </div>
  )
}
