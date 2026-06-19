import {
  CheckmarkCircle02Icon,
  Delete02Icon,
  Notification03Icon,
  NotificationOff03Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { useEffect, useMemo, useRef, useState } from "react"
import { AdapterIcon } from "@/components/adapter-icon"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { muteKey } from "@/lib/notif-mutes"
import {
  flattenRows,
  groupByConversation,
  relativeTime,
  slackGroupLabel,
  slackGroupMeta,
  slackIsMention,
  type ViewEntry,
} from "@/lib/notifications-view"
import { excludeTargetFromEntry } from "@/lib/slack-excludes"
import { cn } from "@/lib/utils"

export type { ViewEntry as NotifEntry }

interface Props {
  notifications: ViewEntry[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onClickItem: (entry: ViewEntry) => void
  onToggleRead: (entry: ViewEntry) => void
  onMarkAllRead: () => void
  onClearAll: () => void
  /** Mark only the selected row's whole thread read (the `r` action key). */
  onMarkThreadRead: (entry: ViewEntry) => void
  /** Remove a whole conversation's entries in one tap (t085). */
  onClearThread: (entry: ViewEntry) => void
  /** Mute the channel/DM behind a swept Slack notification (Channel Exclude, t072). */
  onMuteChannel: (entry: ViewEntry) => void
  /** This device's muted sources (muteKeys), t093 — muted groups render dimmed. */
  mutes?: readonly string[]
  /** Device-aware unread badge (t093, web): excludes this device's muted sources + goes
   *  to 0 when the master is off. Undefined → the own unfiltered unread count. */
  unreadBadge?: number
}

export function NotificationBell({
  notifications,
  open,
  onOpenChange,
  onClickItem,
  onToggleRead,
  onMarkAllRead,
  onClearAll,
  onMarkThreadRead,
  onClearThread,
  onMuteChannel,
  mutes,
  unreadBadge,
}: Props) {
  const [unreadOnly, setUnreadOnly] = useState(false)
  // The badge honors this device's mutes/master (t093) when provided; the LIST below stays
  // unfiltered (muted entries still shown, dimmed) so nothing is silently lost.
  const unread = unreadBadge ?? notifications.filter((n) => !n.read).length
  const visible = unreadOnly ? notifications.filter((n) => !n.read) : notifications
  const groups = groupByConversation(visible)
  // Paint-ordered flat row list — the roving keyboard selection indexes this, so it
  // always matches what the user sees (group headers stay visual-only).
  const rows = useMemo(() => flattenRows(groups), [groups])

  const [selectedIndex, setSelectedIndex] = useState(0)
  const rowRefs = useRef<(HTMLLIElement | null)[]>([])

  // Reset to the top whenever the box opens or the visible list changes (filter
  // toggle, new notification, item removed) so selection never points past the end.
  // biome-ignore lint/correctness/useExhaustiveDependencies: rows.length is the list-changed signal
  useEffect(() => {
    setSelectedIndex(0)
  }, [open, rows.length])

  // Keep the selected row in view as it moves.
  useEffect(() => {
    if (open) rowRefs.current[selectedIndex]?.scrollIntoView({ block: "nearest" })
  }, [open, selectedIndex])

  // Keyboard control while the box is open and focus is trapped in the popover. No input
  // lives in the box, so plain keys are safe (the global ⌥N toggle owns open/close).
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (rows.length === 0) return
    const move = (delta: number) => {
      e.preventDefault()
      setSelectedIndex((i) => (i + delta + rows.length) % rows.length)
    }
    switch (e.key) {
      case "ArrowDown":
      case "j":
        move(1)
        break
      case "ArrowUp":
      case "k":
        move(-1)
        break
      case "Enter":
        e.preventDefault()
        if (rows[selectedIndex]) onClickItem(rows[selectedIndex])
        break
      case "Backspace":
        e.preventDefault()
        onClearAll()
        break
      case "R":
        e.preventDefault()
        onMarkAllRead()
        break
      case "r":
        e.preventDefault()
        if (rows[selectedIndex]) onMarkThreadRead(rows[selectedIndex])
        break
    }
  }

  // Map each entry id to its flat row index so the painted list highlights the selection.
  const indexById = useMemo(() => {
    const m = new Map<string, number>()
    rows.forEach((r, i) => {
      m.set(r.id, i)
    })
    return m
  }, [rows])

  return (
    <Popover onOpenChange={onOpenChange} open={open}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              aria-label={unread ? `${unread} unread notifications` : "Notifications"}
              className="text-muted-foreground hover:text-foreground"
              size="icon-xs"
              variant="ghost"
            >
              {/* Anchor the badge to the glyph footprint, not the Button box — on coarse the
                  Button bumps to 44px (index.css) while the 14px glyph stays centered, so a
                  Button-anchored badge would float ~15px off the icon corner. */}
              <span className="relative inline-flex">
                <HugeiconsIcon className="size-3.5" icon={Notification03Icon} />
                {unread > 0 && (
                  <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-medium leading-none text-primary-foreground tabular-nums">
                    {unread > 9 ? "9+" : unread}
                  </span>
                )}
              </span>
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">Notifications</TooltipContent>
      </Tooltip>
      <PopoverContent
        align="end"
        className="p-0"
        collisionPadding={12}
        onCloseAutoFocus={(e) => e.preventDefault()}
        onKeyDown={onKeyDown}
        sideOffset={8}
      >
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-xs font-medium">Notifications</span>
          {notifications.length > 0 && (
            <div className="flex items-center gap-3">
              <button
                aria-pressed={unreadOnly}
                className={cn(
                  "touch-slop-y text-[10px]",
                  unreadOnly
                    ? "font-medium text-primary"
                    : "text-muted-foreground hover:text-foreground",
                )}
                onClick={() => setUnreadOnly((v) => !v)}
                type="button"
              >
                Unread only
              </button>
              <button
                className="touch-slop-y text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:hover:text-muted-foreground"
                disabled={unread === 0}
                onClick={onMarkAllRead}
                type="button"
              >
                Mark all read
              </button>
              <button
                className="touch-slop-y text-[10px] text-muted-foreground hover:text-foreground"
                onClick={onClearAll}
                type="button"
              >
                Clear all
              </button>
            </div>
          )}
        </div>
        {visible.length === 0 ? (
          <div className="px-3 py-6 text-center text-[11px] text-muted-foreground">
            {unreadOnly ? "No unread notifications" : "No notifications"}
          </div>
        ) : (
          <ScrollArea className="[&>[data-slot=scroll-area-viewport]]:max-h-80 [&>[data-slot=scroll-area-viewport]>div]:!block">
            {groups.map((g) => {
              // Workspace + DM/group-DM kind for Slack groups (t082) — see inbox.tsx.
              const meta = slackGroupMeta(g.items)
              const label = slackGroupLabel(g.items[0]) ?? g.label
              // Muted-on-this-device groups stay listed but dimmed (t093) — capture is
              // global, so nothing is hidden; the badge above already excludes them.
              const groupMuted = !!mutes?.includes(muteKey(g.items[0]))
              return (
                <div className={cn("group/group", groupMuted && "opacity-50")} key={g.key}>
                  {/* Two-line header (t083) — a long workspace name can't push the count off. */}
                  <div className="sticky top-0 z-10 flex flex-col gap-0.5 bg-popover px-3 pb-1 pt-2 text-[10px] font-medium text-muted-foreground">
                    <div className="flex items-center gap-1.5">
                      <AdapterIcon className="size-3.5 shrink-0 rounded-sm" entry={g.items[0]} />
                      <span className="min-w-0 flex-1 truncate">{label}</span>
                      {g.unread > 0 && (
                        <span className="shrink-0 rounded-full bg-primary/15 px-1.5 text-[9px] font-medium text-primary tabular-nums">
                          {g.unread}
                        </span>
                      )}
                      {/* Per-conversation actions (t085): read / mute / clear the whole
                          channel in one click, shown on hover/touch. */}
                      {g.unread > 0 && (
                        <button
                          aria-label="Mark conversation read"
                          className="-m-0.5 shrink-0 p-0.5 text-muted-foreground/50 opacity-0 hover:text-foreground group-hover/group:opacity-100 [@media(hover:none)]:opacity-100"
                          onClick={() => onMarkThreadRead(g.items[0])}
                          type="button"
                        >
                          <HugeiconsIcon className="size-3" icon={CheckmarkCircle02Icon} />
                        </button>
                      )}
                      {excludeTargetFromEntry(g.items[0]) && (
                        <button
                          aria-label="Mute this channel"
                          className="-m-0.5 shrink-0 p-0.5 text-muted-foreground/50 opacity-0 hover:text-foreground group-hover/group:opacity-100 [@media(hover:none)]:opacity-100"
                          onClick={() => onMuteChannel(g.items[0])}
                          type="button"
                        >
                          <HugeiconsIcon className="size-3" icon={NotificationOff03Icon} />
                        </button>
                      )}
                      <button
                        aria-label="Clear conversation"
                        className="-m-0.5 shrink-0 p-0.5 text-muted-foreground/50 opacity-0 hover:text-foreground group-hover/group:opacity-100 [@media(hover:none)]:opacity-100"
                        onClick={() => onClearThread(g.items[0])}
                        type="button"
                      >
                        <HugeiconsIcon className="size-3" icon={Delete02Icon} />
                      </button>
                    </div>
                    {meta && (
                      <span className="truncate pl-5 font-normal text-[9px] text-muted-foreground/70">
                        {meta.workspace}
                        {meta.kind === "dm"
                          ? " · DM"
                          : meta.kind === "group-dm"
                            ? " · Group DM"
                            : ""}
                      </span>
                    )}
                  </div>
                  <ul className="pb-1">
                    {g.items.map((n) => {
                      const rowIndex = indexById.get(n.id) ?? -1
                      const isSelected = rowIndex === selectedIndex
                      const mention = slackIsMention(n)
                      return (
                        <li
                          className={cn(
                            "group/noti relative hover:bg-accent",
                            !n.read && "bg-accent/40",
                            mention && "border-l-2 border-primary bg-primary/5",
                            isSelected && "bg-accent ring-1 ring-inset ring-primary/40",
                          )}
                          key={n.id}
                          ref={(el) => {
                            if (rowIndex >= 0) rowRefs.current[rowIndex] = el
                          }}
                        >
                          <button
                            aria-current={isSelected || undefined}
                            className={cn(
                              "flex w-full flex-col justify-center gap-0.5 py-2 pr-14 text-left touch-target",
                              mention ? "pl-[calc(0.75rem-2px)]" : "pl-3",
                            )}
                            onClick={() => onClickItem(n)}
                            type="button"
                          >
                            {mention && (
                              <span className="w-fit rounded bg-primary/15 px-1 text-[9px] font-semibold text-primary">
                                @you
                              </span>
                            )}
                            <span className="line-clamp-2 text-xs">
                              {n.body || n.source || n.title}
                            </span>
                          </button>
                          <div className="pointer-events-none absolute top-2 right-3 flex items-center gap-1.5">
                            {excludeTargetFromEntry(n) && (
                              <button
                                aria-label="Mute this channel"
                                className="pointer-events-auto -m-1 p-1 text-muted-foreground/50 opacity-0 transition-opacity hover:text-foreground group-hover/noti:opacity-100 [@media(hover:none)]:opacity-100"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  onMuteChannel(n)
                                }}
                                type="button"
                              >
                                <HugeiconsIcon className="size-3" icon={NotificationOff03Icon} />
                              </button>
                            )}
                            <button
                              aria-label={n.read ? "Mark as unread" : "Mark as read"}
                              className="pointer-events-auto -m-1 p-1"
                              onClick={(e) => {
                                e.stopPropagation()
                                onToggleRead(n)
                              }}
                              type="button"
                            >
                              <span
                                className={cn(
                                  "block size-2 rounded-full transition-colors",
                                  n.read
                                    ? "border border-muted-foreground/40 opacity-0 group-hover/noti:opacity-100 [@media(hover:none)]:opacity-100 hover:bg-muted-foreground/20"
                                    : "bg-primary hover:bg-primary/70",
                                )}
                              />
                            </button>
                            <span className="text-[10px] text-muted-foreground tabular-nums">
                              {relativeTime(n.ts, Date.now())}
                            </span>
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                  {g.total > g.items.length && (
                    <div className="px-3 pb-1.5 text-[10px] text-muted-foreground">
                      +{g.total - g.items.length} earlier
                    </div>
                  )}
                </div>
              )
            })}
          </ScrollArea>
        )}
      </PopoverContent>
    </Popover>
  )
}
