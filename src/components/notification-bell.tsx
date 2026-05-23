import { Notification03Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { groupByConversation, type ViewEntry } from "@/lib/notifications-view"
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
}

function relativeTime(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000)
  if (s < 60) return "now"
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

export function NotificationBell({
  notifications,
  open,
  onOpenChange,
  onClickItem,
  onToggleRead,
  onMarkAllRead,
  onClearAll,
}: Props) {
  const [unreadOnly, setUnreadOnly] = useState(false)
  const unread = notifications.filter((n) => !n.read).length
  const visible = unreadOnly ? notifications.filter((n) => !n.read) : notifications
  const groups = groupByConversation(visible)

  return (
    <Popover onOpenChange={onOpenChange} open={open}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              aria-label={unread ? `${unread} unread notifications` : "Notifications"}
              className="relative text-muted-foreground hover:text-foreground"
              size="icon-xs"
              variant="ghost"
            >
              <HugeiconsIcon className="size-3.5" icon={Notification03Icon} />
              {unread > 0 && (
                <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-medium leading-none text-primary-foreground tabular-nums">
                  {unread > 9 ? "9+" : unread}
                </span>
              )}
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Notifications</TooltipContent>
      </Tooltip>
      <PopoverContent
        align="end"
        className="p-0"
        collisionPadding={12}
        onCloseAutoFocus={(e) => e.preventDefault()}
        sideOffset={8}
      >
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-xs font-medium">Notifications</span>
          {notifications.length > 0 && (
            <div className="flex items-center gap-3">
              <button
                aria-pressed={unreadOnly}
                className={cn(
                  "text-[10px]",
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
                className="text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:hover:text-muted-foreground"
                disabled={unread === 0}
                onClick={onMarkAllRead}
                type="button"
              >
                Mark all read
              </button>
              <button
                className="text-[10px] text-muted-foreground hover:text-foreground"
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
          <ScrollArea className="max-h-80 [&>[data-slot=scroll-area-viewport]>div]:!block">
            {groups.map((g) => (
              <div key={g.key}>
                <div className="sticky top-0 flex items-center gap-1.5 bg-popover px-3 pb-1 pt-2 text-[10px] font-medium text-muted-foreground">
                  {g.icon && (
                    <img
                      alt=""
                      className="size-3.5 shrink-0 rounded-sm"
                      onError={(e) => {
                        ;(e.target as HTMLImageElement).style.display = "none"
                      }}
                      src={g.icon}
                    />
                  )}
                  <span className="min-w-0 truncate">{g.label}</span>
                  {g.unread > 0 && (
                    <span className="ml-auto shrink-0 rounded-full bg-primary/15 px-1.5 text-[9px] font-medium text-primary tabular-nums">
                      {g.unread}
                    </span>
                  )}
                </div>
                <ul className="pb-1">
                  {g.items.map((n) => (
                    <li
                      className={cn(
                        "group/noti relative hover:bg-accent",
                        !n.read && "bg-accent/40",
                      )}
                      key={n.id}
                    >
                      <button
                        className="flex w-full flex-col gap-0.5 py-2 pl-3 pr-12 text-left"
                        onClick={() => onClickItem(n)}
                        type="button"
                      >
                        <span className="line-clamp-2 text-xs font-medium">
                          {n.title || n.source}
                        </span>
                        {n.body && (
                          <span className="line-clamp-2 text-[11px] text-muted-foreground">
                            {n.body}
                          </span>
                        )}
                      </button>
                      <div className="pointer-events-none absolute top-2 right-3 flex flex-col items-end gap-1.5">
                        <span className="text-[10px] text-muted-foreground tabular-nums">
                          {relativeTime(n.ts)}
                        </span>
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
                                ? "border border-muted-foreground/40 opacity-0 group-hover/noti:opacity-100 hover:bg-muted-foreground/20"
                                : "bg-primary hover:bg-primary/70",
                            )}
                          />
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </ScrollArea>
        )}
      </PopoverContent>
    </Popover>
  )
}
