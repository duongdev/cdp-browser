import {
  CheckmarkCircle02Icon,
  Delete02Icon,
  GlobalIcon,
  Notification03Icon,
  NotificationOff03Icon,
  Settings01Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { useState } from "react"
import { AdapterIcon } from "@/components/adapter-icon"
import type { NotifEntry } from "@/components/notification-bell"
import { Button } from "@/components/ui/button"
import {
  groupByConversation,
  relativeTime,
  slackGroupLabel,
  slackGroupMeta,
  slackIsMention,
} from "@/lib/notifications-view"
import { excludeTargetFromEntry } from "@/lib/slack-excludes"
import { cn } from "@/lib/utils"

interface Props {
  notifications: NotifEntry[]
  onClickItem: (entry: NotifEntry) => void
  onToggleRead: (entry: NotifEntry) => void
  onMarkAllRead: () => void
  /** Mark a whole conversation read in one tap (t085). */
  onMarkThreadRead: (entry: NotifEntry) => void
  /** Remove a whole conversation's entries in one tap (t085). */
  onClearThread: (entry: NotifEntry) => void
  onMuteChannel: (entry: NotifEntry) => void
  /** Reach the screencast browser view without a notification (header + empty state). */
  onOpenBrowser: () => void
  onOpenSettings: () => void
}

/**
 * The Phone Shell's root view (t076, ADR-0012): the full-screen notification list
 * grouped by conversation. Same pure read model as the bell popover
 * (`groupByConversation`); the row presentation is its own — phone-sized targets,
 * full-bleed scroll — by design, not a fork of the popover's desktop-density JSX.
 */
export function Inbox({
  notifications,
  onClickItem,
  onToggleRead,
  onMarkAllRead,
  onMarkThreadRead,
  onClearThread,
  onMuteChannel,
  onOpenBrowser,
  onOpenSettings,
}: Props) {
  const [unreadOnly, setUnreadOnly] = useState(false)
  const unread = notifications.filter((n) => !n.read).length
  const visible = unreadOnly ? notifications.filter((n) => !n.read) : notifications
  const groups = groupByConversation(visible)

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4">
        <span className="text-sm font-semibold">Inbox</span>
        {unread > 0 && (
          <span className="rounded-full bg-primary/15 px-1.5 text-[10px] font-medium text-primary tabular-nums">
            {unread}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <button
            aria-pressed={unreadOnly}
            className={cn(
              "touch-slop-y px-1 text-[11px]",
              unreadOnly ? "font-medium text-primary" : "text-muted-foreground",
            )}
            onClick={() => setUnreadOnly((v) => !v)}
            type="button"
          >
            Unread
          </button>
          <button
            className="touch-slop-y px-1 text-[11px] text-muted-foreground disabled:opacity-40"
            disabled={unread === 0}
            onClick={onMarkAllRead}
            type="button"
          >
            Read all
          </button>
          <Button
            aria-label="Open browser"
            className="text-muted-foreground"
            onClick={onOpenBrowser}
            size="icon-xs"
            variant="ghost"
          >
            <HugeiconsIcon className="size-4" icon={GlobalIcon} />
          </Button>
          <Button
            aria-label="Settings"
            className="text-muted-foreground"
            onClick={onOpenSettings}
            size="icon-xs"
            variant="ghost"
          >
            <HugeiconsIcon className="size-4" icon={Settings01Icon} />
          </Button>
        </div>
      </header>
      {visible.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <HugeiconsIcon className="size-8 text-muted-foreground/40" icon={Notification03Icon} />
          <p className="text-sm text-muted-foreground">
            {unreadOnly ? "No unread notifications" : "No notifications yet"}
          </p>
          <Button onClick={onOpenBrowser} size="sm" variant="outline">
            Open browser
          </Button>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          {groups.map((g) => {
            // Where this conversation lives (t082): workspace + DM/group-DM kind for
            // Slack groups — multi-workspace users can't tell same-named channels apart
            // from the title alone. Channels keep just the workspace (the # is in the label).
            const meta = slackGroupMeta(g.items)
            // Clean Slack conversation label (#channel / @DM), else the entry title (t090).
            const label = slackGroupLabel(g.items[0]) ?? g.label
            return (
              <section key={g.key}>
                {/* Two-line header (t083): workspace names can be long ("FWD GROUP
                    MANAGEMENT HOLDINGS LIMITED") — keeping them on their own line means a
                    long name can never push the unread count or the row controls off-screen. */}
                <div className="sticky top-0 z-10 flex flex-col gap-0.5 bg-background/95 px-4 pb-1 pt-3 text-[11px] font-medium text-muted-foreground backdrop-blur">
                  <div className="flex items-center gap-2">
                    <AdapterIcon className="size-4 shrink-0 rounded-sm" entry={g.items[0]} />
                    <span className="min-w-0 flex-1 truncate">{label}</span>
                    {g.unread > 0 && (
                      <span className="shrink-0 rounded-full bg-primary/15 px-1.5 text-[10px] font-medium text-primary tabular-nums">
                        {g.unread}
                      </span>
                    )}
                    {/* Per-conversation actions (t085): one tap to read / mute / clear the
                        whole channel, instead of hunting per-message. */}
                    {g.unread > 0 && (
                      <button
                        aria-label="Mark conversation read"
                        className="-m-1 shrink-0 p-1 text-muted-foreground/60 active:text-foreground"
                        onClick={() => onMarkThreadRead(g.items[0])}
                        type="button"
                      >
                        <HugeiconsIcon className="size-4" icon={CheckmarkCircle02Icon} />
                      </button>
                    )}
                    {excludeTargetFromEntry(g.items[0]) && (
                      <button
                        aria-label="Mute this channel"
                        className="-m-1 shrink-0 p-1 text-muted-foreground/60 active:text-foreground"
                        onClick={() => onMuteChannel(g.items[0])}
                        type="button"
                      >
                        <HugeiconsIcon className="size-4" icon={NotificationOff03Icon} />
                      </button>
                    )}
                    <button
                      aria-label="Clear conversation"
                      className="-m-1 shrink-0 p-1 text-muted-foreground/60 active:text-foreground"
                      onClick={() => onClearThread(g.items[0])}
                      type="button"
                    >
                      <HugeiconsIcon className="size-4" icon={Delete02Icon} />
                    </button>
                  </div>
                  {meta && (
                    <span className="truncate pl-6 text-[10px] font-normal text-muted-foreground/70">
                      {meta.workspace}
                      {meta.kind === "dm" ? " · DM" : meta.kind === "group-dm" ? " · Group DM" : ""}
                    </span>
                  )}
                </div>
                <ul>
                  {g.items.map((n) => {
                    const mention = slackIsMention(n)
                    return (
                      <li
                        className={cn(
                          "group/noti relative",
                          !n.read && "bg-accent/40",
                          // Mention highlight (t090): a primary left bar + tint so an @you
                          // stands out from ambient channel/DM traffic.
                          mention && "border-l-2 border-primary bg-primary/5",
                        )}
                        key={n.id}
                      >
                        <button
                          className={cn(
                            "flex w-full flex-col justify-center gap-1 py-3 pr-20 text-left touch-target",
                            mention ? "pl-[calc(1rem-2px)]" : "pl-4",
                          )}
                          onClick={() => onClickItem(n)}
                          type="button"
                        >
                          <div className="flex items-center gap-1.5">
                            {mention && (
                              <span className="shrink-0 rounded bg-primary/15 px-1 text-[9px] font-semibold text-primary">
                                @you
                              </span>
                            )}
                            {n.slackThreadTs && (
                              <span className="text-[10px] leading-none text-muted-foreground">
                                ↳ thread
                              </span>
                            )}
                          </div>
                          <span className="line-clamp-3 break-words text-sm leading-snug [overflow-wrap:anywhere]">
                            {n.body || n.source || n.title}
                          </span>
                        </button>
                        <div className="pointer-events-none absolute right-4 top-3 flex items-center gap-2">
                          {excludeTargetFromEntry(n) && (
                            <button
                              aria-label="Mute this channel"
                              className="pointer-events-auto -m-1 p-1 text-muted-foreground/50"
                              onClick={(e) => {
                                e.stopPropagation()
                                onMuteChannel(n)
                              }}
                              type="button"
                            >
                              <HugeiconsIcon className="size-3.5" icon={NotificationOff03Icon} />
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
                                "block size-2.5 rounded-full",
                                n.read ? "border border-muted-foreground/40" : "bg-primary",
                              )}
                            />
                          </button>
                          <span className="text-[11px] text-muted-foreground tabular-nums">
                            {relativeTime(n.ts, Date.now())}
                          </span>
                        </div>
                      </li>
                    )
                  })}
                </ul>
                {g.total > g.items.length && (
                  <div className="px-4 pb-2 text-[11px] text-muted-foreground">
                    +{g.total - g.items.length} earlier
                  </div>
                )}
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}
