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
import {
  conversationLabelStatus,
  isUnread,
  previewLine,
  relativeTime,
} from "../lib/conversation-view"
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
    // Raw title (pref-independent) — the avatar initials clean this themselves (strip org/tags),
    // so a "first name"/regex display pref never starves them of the real name (PSN-99).
    const { label: rawLabel, pending } = conversationLabelStatus(conversation)
    const avatarName = rawLabel
    const label = formatConversationLabel(rawLabel, conversation, namePref ?? FULL_NAME)
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
          "conv-row flex w-full flex-col rounded-lg px-3 py-2.5 text-left transition-colors",
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
        {/* Avatar + the first two text rows (title, preview). The avatar is centered over these two
            rows only (items-center here) — a third labels row below sits outside this flex, so the
            avatar keeps its position instead of re-centering over three rows. */}
        <span className="flex w-full items-center gap-3">
          {/* Avatar-anchored unread indicator (t168, unified t170): one badge on the avatar corner —
              a plain coral dot for unread, the same badge grown into a numbered pill when there are
              unread @mentions (a local floor — only synced pages count). Same spot for single +
              facepile so it never shifts row layout. The wrapper is an explicitly sized block (t170
              fix): a bare inline span collapsed and let the facepile circles spill across rows. */}
          <span className="relative block size-10 shrink-0">
            {conversation.kind === "group" && (conversation.memberIds?.length ?? 0) >= 2 ? (
              <FacepileAvatar label={avatarName} memberIds={conversation.memberIds ?? []} />
            ) : (
              <UserAvatar label={avatarName} userId={conversation.avatarUserId} />
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
                {pending ? (
                  <span
                    aria-label={title}
                    className="h-3.5 w-2/5 animate-pulse rounded bg-muted"
                    role="status"
                  />
                ) : (
                  <span
                    className={cn(
                      "conv-row-title truncate text-foreground",
                      unread ? "font-semibold" : "font-medium",
                    )}
                  >
                    {title}
                  </span>
                )}
                {/* Original label intentionally omitted from the row — the rename IS the identity here.
                    The original stays readable in the thread's top toolbar. */}
              </span>
              <span className="flex shrink-0 items-center gap-1.5">
                {time && <span className="font-mono text-xs text-muted-foreground">{time}</span>}
              </span>
            </span>
            {/* Second row: preview + optional mute bell. The bell lives here so it doesn't compete
                with the timestamp — muted is a background state, not a notification. */}
            <span className="mt-0.5 flex items-center gap-1">
              <span
                className={cn(
                  "conv-row-preview min-w-0 flex-1 truncate text-sm",
                  unread ? "font-semibold text-foreground/80" : "text-muted-foreground",
                )}
              >
                {previewLine(conversation)}
              </span>
              {muted && (
                <HugeiconsIcon
                  aria-label="Muted"
                  className="size-3 shrink-0 text-muted-foreground/50"
                  icon={NotificationOff03Icon}
                />
              )}
            </span>
          </span>
        </span>
        {/* Third row: labels. Indented past the avatar (size-10 + gap-3 = 3.25rem) so they align
            under the title/preview text column, not under the avatar. */}
        {labels.length > 0 && (
          <span className="mt-1 flex flex-wrap gap-1 pl-13">
            {labels.map((l) => (
              <span
                className="shrink-0 rounded-full border border-border/70 px-1.5 py-px font-medium text-[10px] text-muted-foreground"
                key={l}
              >
                {l}
              </span>
            ))}
          </span>
        )}
      </button>
    )
  },
)
