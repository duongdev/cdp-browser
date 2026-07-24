import { NotificationOff03Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  type ComponentPropsWithoutRef,
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react"
import { cn } from "@/lib/utils"
import { conversationLabel, isUnread, previewLine, relativeTime } from "../lib/conversation-view"
import { FULL_NAME, formatConversationLabel, type NamePref } from "../lib/display-name"
import type { TeamsConversation } from "../lib/teams-client"
import { FacepileAvatar, UserAvatar } from "./user-avatar"

interface ConversationRowProps extends ComponentPropsWithoutRef<"button"> {
  conversation: TeamsConversation
  onOpen: (conversation: TeamsConversation) => void
  active?: boolean
  /** Keyboard cursor (t152): draws the coral --ring + scrolls into view. Distinct from `active`
   *  (the open thread) — the keyboard cursor can hover a row before Enter opens it. */
  focused?: boolean
  /** Name display preference (t161) — applied to 1:1 labels. */
  namePref?: NamePref
  /** Live clock for the relative time (t168) — the list ticks it every 30s so "5m" can't go stale. */
  now?: number
}

/** One conversation entry: avatar initial + label + last-message preview + relative time.
 *  Forwards its ref + spreads extra props so Radix `ContextMenuTrigger asChild` can bind
 *  `onContextMenu` to the real `<button>` (t156 right-click menu). */
export const ConversationRow = forwardRef<HTMLButtonElement, ConversationRowProps>(
  function ConversationRow(
    { conversation, onOpen, active, focused, namePref, now, className, onClick, ...rest },
    forwardedRef,
  ) {
    const label = formatConversationLabel(
      conversationLabel(conversation),
      conversation,
      namePref ?? FULL_NAME,
    )
    // Local rename (t168): the custom title leads; the original stays visible, small + muted.
    const customTitle = conversation.customTitle
    const title = customTitle || label
    const time = relativeTime(conversation.lastMessageTs, now)
    const unread = isUnread(conversation)
    const muted = !!conversation.muted
    const mentions = conversation.mentionCount ?? 0
    const labels = conversation.labels ?? []
    const ref = useRef<HTMLButtonElement>(null)
    useImperativeHandle(forwardedRef, () => ref.current as HTMLButtonElement)

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
          className,
        )}
        onClick={(e) => {
          onClick?.(e)
          onOpen(conversation)
        }}
        ref={ref}
        type="button"
        {...rest}
      >
        {/* Avatar-anchored unread indicator (t168, unified t170): one badge on the avatar corner —
            a plain coral dot for unread, the same badge grown into a numbered pill when there are
            unread @mentions (a local floor — only synced pages count). Same spot for single +
            facepile so it never shifts row layout. The wrapper is an explicitly sized block (t170
            fix): a bare inline span collapsed and let the facepile circles spill across rows. */}
        <span className="relative block size-10 shrink-0">
          {conversation.kind === "group" && (conversation.memberIds?.length ?? 0) >= 2 ? (
            <FacepileAvatar label={label} memberIds={conversation.memberIds ?? []} />
          ) : (
            <UserAvatar label={label} userId={conversation.avatarUserId} />
          )}
          {mentions > 0 ? (
            <span
              aria-label={`${mentions} unread mention${mentions === 1 ? "" : "s"}`}
              className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-ring px-1 font-mono font-semibold text-[10px] text-background ring-2 ring-background"
              role="status"
              title={`${mentions} unread mention${mentions === 1 ? "" : "s"}`}
            >
              {mentions}
            </span>
          ) : (
            unread && (
              <span
                aria-label="Unread"
                className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-ring ring-2 ring-background"
                role="img"
                title="Unread"
              />
            )
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className="flex min-w-0 items-baseline gap-1.5">
              <span
                className={cn("truncate text-foreground", unread ? "font-semibold" : "font-medium")}
              >
                {title}
              </span>
              {customTitle && (
                <span className="hidden truncate text-[11px] text-muted-foreground sm:inline">
                  {label}
                </span>
              )}
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
              {/* Unread + @mention indicators both live on the avatar corner now (unified t170);
                  this column keeps only the mute bell. */}
              {muted && (
                <HugeiconsIcon
                  aria-label="Muted"
                  className="size-3.5 text-muted-foreground"
                  icon={NotificationOff03Icon}
                />
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
  },
)
