import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core"
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers"
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import {
  ArrowDown01Icon,
  Cancel01Icon,
  Globe02Icon,
  PlusSignIcon,
  SidebarLeft01Icon,
  SidebarLeftIcon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import type { PointerEvent as ReactPointerEvent } from "react"
import { useState } from "react"
import type { TabInfo } from "@/app"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

interface SidebarProps {
  tabs: TabInfo[]
  activeTabId: string | null
  unreadByTab: Record<string, number>
  onSwitchTab: (id: string) => void
  onCloseTab: (id: string) => void
  onNewTab: () => void
  collapsed: boolean
  onToggleCollapse: () => void
  width: number
  onResize: (width: number) => void
  onResizeEnd: (width: number) => void
  pinnedOpen: boolean
  onPinnedToggle: () => void
  bookmarks: Bookmark[]
  onNavigateBookmark: (url: string) => void
  onOpenBookmarkInNewTab: (url: string) => void
  onRemoveBookmark: (url: string) => void
  onReorderBookmarks: (bookmarks: Bookmark[]) => void
  onReorderTabs: (tabs: TabInfo[]) => void
}

const MIN_WIDTH = 180
const MAX_WIDTH = 480

export function Sidebar({
  tabs,
  activeTabId,
  unreadByTab,
  onSwitchTab,
  onCloseTab,
  onNewTab,
  collapsed,
  onToggleCollapse,
  width,
  onResize,
  onResizeEnd,
  pinnedOpen,
  onPinnedToggle,
  bookmarks,
  onNavigateBookmark,
  onOpenBookmarkInNewTab,
  onRemoveBookmark,
  onReorderBookmarks,
  onReorderTabs,
}: SidebarProps) {
  const [resizing, setResizing] = useState(false)

  const handleResizeStart = (e: ReactPointerEvent) => {
    e.preventDefault()
    setResizing(true)
    const startX = e.clientX
    const startWidth = width
    let latest = startWidth
    const onMove = (ev: PointerEvent) => {
      latest = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + ev.clientX - startX))
      onResize(latest)
    }
    const onUp = () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      setResizing(false)
      onResizeEnd(latest)
    }
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
  }

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 3 } }))

  const handleBookmarkDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (over && active.id !== over.id) {
      const oldIndex = bookmarks.findIndex((b) => b.id === active.id)
      const newIndex = bookmarks.findIndex((b) => b.id === over.id)
      onReorderBookmarks(arrayMove(bookmarks, oldIndex, newIndex))
    }
  }

  const handleTabDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (over && active.id !== over.id) {
      const oldIndex = tabs.findIndex((t) => t.id === active.id)
      const newIndex = tabs.findIndex((t) => t.id === over.id)
      onReorderTabs(arrayMove(tabs, oldIndex, newIndex))
    }
  }

  return (
    <div
      className={cn(
        // min-w-0 so a long tab title can't force the sidebar wider than its set
        // width (otherwise flexbox min-width:auto grows it to the longest label).
        "relative flex flex-col bg-sidebar shrink-0 min-w-0",
        !resizing && "transition-all duration-200",
      )}
      style={collapsed ? { width: 52 } : { width }}
    >
      {/* Right divider. Lower part is always shown; the top (traffic-light)
          segment fades out when collapsing so it stops cutting the traffic
          lights, in sync with the width animation. */}
      <div className="pointer-events-none absolute right-0 top-11 bottom-0 w-px bg-sidebar-border" />
      <div
        className={cn(
          "pointer-events-none absolute right-0 top-0 h-11 w-px bg-sidebar-border transition-opacity duration-200",
          collapsed ? "opacity-0" : "opacity-100",
        )}
      />

      {/* Resize handle (expanded only) */}
      {!collapsed && (
        <div
          className="absolute -right-1 top-0 bottom-0 z-20 w-2 cursor-col-resize hover:bg-primary/30"
          onPointerDown={handleResizeStart}
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        />
      )}

      {/* Drag region (traffic lights area) */}
      <div
        className="h-11 shrink-0 relative"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      >
        {/* Collapse button beside the traffic lights (absolute — no layout cost). */}
        {!collapsed && (
          <div
            className="absolute top-2.5 right-2 z-10 animate-in fade-in-0 duration-200"
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  className="text-muted-foreground hover:text-foreground"
                  onClick={onToggleCollapse}
                  size="icon-xs"
                  variant="ghost"
                >
                  <HugeiconsIcon className="size-3.5" icon={SidebarLeft01Icon} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">Collapse sidebar</TooltipContent>
            </Tooltip>
          </div>
        )}
      </div>

      {/* Expand button below the traffic lights when collapsed. The row height
          animates with the sidebar (grid 0fr↔1fr) so the tab list glides instead
          of jumping — space is reserved by the transition itself, no JS. */}
      <div
        className={cn(
          "grid shrink-0 transition-[grid-template-rows,opacity] duration-200",
          collapsed
            ? "grid-rows-[1fr] opacity-100"
            : "grid-rows-[0fr] opacity-0 pointer-events-none",
        )}
      >
        <div className="overflow-hidden">
          <div className="flex justify-center pt-0.5 pb-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  className="text-muted-foreground hover:text-foreground"
                  onClick={onToggleCollapse}
                  size="icon-xs"
                  variant="ghost"
                >
                  <HugeiconsIcon className="size-3.5" icon={SidebarLeftIcon} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">Expand sidebar</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </div>

      {/* Pinned section */}
      {bookmarks.length > 0 && (
        <div className="shrink-0">
          {!collapsed && (
            <button
              className="flex items-center justify-between px-3 pb-1 w-full"
              onClick={onPinnedToggle}
              type="button"
            >
              <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground select-none">
                Pinned
              </span>
              <HugeiconsIcon
                className={cn(
                  "size-3 text-muted-foreground transition-transform duration-200",
                  !pinnedOpen && "-rotate-90",
                )}
                icon={ArrowDown01Icon}
              />
            </button>
          )}
          {(pinnedOpen || collapsed) && (
            <div className="px-2 pb-1">
              <DndContext
                collisionDetection={closestCenter}
                modifiers={[restrictToVerticalAxis, restrictToParentElement]}
                onDragEnd={handleBookmarkDragEnd}
                sensors={sensors}
              >
                <SortableContext
                  items={bookmarks.map((b) => b.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="space-y-0.5">
                    {bookmarks.map((b) => (
                      <SortableBookmarkItem
                        bookmark={b}
                        collapsed={collapsed}
                        key={b.id}
                        onMiddleClick={() => onOpenBookmarkInNewTab(b.url)}
                        onNavigate={() => onNavigateBookmark(b.url)}
                        onRemove={() => onRemoveBookmark(b.url)}
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            </div>
          )}
        </div>
      )}

      {/* Tabs section label */}
      {!collapsed && (
        <div className="px-3 pt-1 pb-1 shrink-0">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground select-none">
            Tabs
          </span>
        </div>
      )}
      {collapsed && bookmarks.length > 0 && (
        <div className="px-3 pt-1 pb-1 shrink-0">
          <div className="border-t border-sidebar-border" />
        </div>
      )}

      {/* Tab list */}
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
        <DndContext
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis, restrictToParentElement]}
          onDragEnd={handleTabDragEnd}
          sensors={sensors}
        >
          <SortableContext items={tabs.map((t) => t.id)} strategy={verticalListSortingStrategy}>
            <div className="space-y-0.5 px-2 py-1">
              {tabs.map((tab) => (
                <SortableTabItem
                  active={tab.id === activeTabId}
                  collapsed={collapsed}
                  key={tab.id}
                  onClose={() => onCloseTab(tab.id)}
                  onSwitch={() => onSwitchTab(tab.id)}
                  tab={tab}
                  unread={unreadByTab[tab.id] || 0}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      </div>

      {/* New tab button */}
      <div className="p-2 border-t border-sidebar-border shrink-0">
        <Tooltip delayDuration={collapsed ? 0 : 600}>
          <TooltipTrigger asChild>
            <button
              className={cn(
                "group/new flex w-full items-center overflow-hidden rounded-lg py-1.5 text-muted-foreground transition-[background-color,box-shadow,color] duration-200 hover:text-foreground",
                // Collapsed: outlined via ring (non-layout, so the box never changes and
                // the icon stays dead-centre). Expanded: borderless ghost row with a hover
                // fill. The icon lives in a fixed left slot in both states, so it never moves.
                collapsed
                  ? "bg-background ring-1 ring-inset ring-border dark:bg-input/30"
                  : "hover:bg-foreground/[0.06]",
              )}
              onClick={onNewTab}
              type="button"
            >
              {/* Fixed-width leading slot = the collapsed rail's inner width, so the icon
                  stays at the rail centre in both states. Collapsing only shrinks the
                  label — the icon never moves, so there's no jump. */}
              <span className="grid w-9 shrink-0 place-items-center">
                <HugeiconsIcon className="size-4" icon={PlusSignIcon} />
              </span>
              <span
                className={cn(
                  "text-xs truncate transition-all duration-200",
                  collapsed ? "max-w-0 opacity-0" : "max-w-[600px] opacity-100",
                )}
              >
                New Tab
              </span>
            </button>
          </TooltipTrigger>
          {collapsed && <TooltipContent side="right">New Tab</TooltipContent>}
        </Tooltip>
      </div>
    </div>
  )
}

// --- Sortable Bookmark Item ---

function SortableBookmarkItem({
  bookmark,
  collapsed,
  onNavigate,
  onMiddleClick,
  onRemove,
}: {
  bookmark: Bookmark
  collapsed: boolean
  onNavigate: () => void
  onMiddleClick: () => void
  onRemove: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: bookmark.id,
  })

  const style = {
    transform: CSS.Transform.toString(transform),
    // Merge collapse animations into dnd-kit's inline transition (which would
    // otherwise be transform-only and freeze these CSS transitions).
    transition: [transition, "padding 200ms ease, background-color 150ms ease"]
      .filter(Boolean)
      .join(", "),
    zIndex: isDragging ? 50 : undefined,
    opacity: isDragging ? 0.8 : undefined,
  }

  return (
    <Tooltip delayDuration={collapsed ? 0 : 600}>
      <TooltipTrigger asChild>
        <div
          ref={setNodeRef}
          style={style}
          {...attributes}
          {...listeners}
          className={cn(
            "group relative flex items-center rounded-lg cursor-default text-sidebar-foreground hover:bg-foreground/[0.06] hover:text-foreground",
            collapsed ? "px-2.5 py-1.5 gap-0" : "px-2.5 py-1.5 gap-2",
            isDragging && "bg-foreground/10",
          )}
          onAuxClick={(e) => {
            if (e.button === 1) {
              e.preventDefault()
              onMiddleClick()
            }
          }}
          onClick={onNavigate}
        >
          <BookmarkFavicon favicon={bookmark.favicon} />
          <span
            className={cn(
              "text-xs truncate transition-all duration-200",
              collapsed ? "max-w-0 opacity-0 flex-none" : "flex-1 max-w-[600px] opacity-100",
            )}
          >
            {bookmark.title}
          </span>
          {!collapsed && (
            <button
              className="hidden group-hover:flex absolute right-2 text-muted-foreground hover:text-foreground"
              onClick={(e) => {
                e.stopPropagation()
                onRemove()
              }}
              onPointerDown={(e) => e.stopPropagation()}
              type="button"
            >
              <HugeiconsIcon className="size-3" icon={Cancel01Icon} />
            </button>
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent className="max-w-[250px]" side="right">
        <p className="text-xs font-medium">{bookmark.title}</p>
        {!collapsed && <p className="text-[10px] text-background/60 truncate">{bookmark.url}</p>}
      </TooltipContent>
    </Tooltip>
  )
}

// --- Sortable Tab Item ---

function SortableTabItem({
  tab,
  active,
  collapsed,
  unread,
  onSwitch,
  onClose,
}: {
  tab: TabInfo
  active: boolean
  collapsed: boolean
  unread: number
  onSwitch: () => void
  onClose: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tab.id,
  })

  const style = {
    transform: CSS.Transform.toString(transform),
    // Merge collapse animations into dnd-kit's inline transition (which would
    // otherwise be transform-only and freeze these CSS transitions).
    transition: [transition, "padding 200ms ease, background-color 150ms ease"]
      .filter(Boolean)
      .join(", "),
    zIndex: isDragging ? 50 : undefined,
    opacity: isDragging ? 0.8 : undefined,
  }

  const displayTitle = tab.title || "New Tab"

  return (
    <Tooltip delayDuration={600}>
      <TooltipTrigger asChild>
        <div
          ref={setNodeRef}
          style={style}
          {...attributes}
          {...listeners}
          className={cn(
            "group relative flex items-center rounded-lg cursor-default",
            collapsed ? "px-2.5 py-1.5 gap-0" : "px-2.5 py-1.5 gap-2",
            isDragging
              ? "bg-foreground/10"
              : active
                ? "bg-foreground/10 text-foreground shadow-sm"
                : "text-sidebar-foreground hover:bg-foreground/[0.06] hover:text-foreground",
          )}
          onAuxClick={(e) => {
            if (e.button === 1) {
              e.preventDefault()
              onClose()
            }
          }}
          onClick={onSwitch}
        >
          <span className="relative shrink-0">
            {tab.faviconUrl ? (
              <img
                alt=""
                aria-hidden="true"
                className="size-4 rounded-sm"
                onError={(e) => {
                  ;(e.target as HTMLImageElement).style.display = "none"
                }}
                src={tab.faviconUrl}
              />
            ) : (
              <div className="size-4 rounded-sm bg-muted" />
            )}
            {unread > 0 && (
              <span className="absolute -right-1.5 -top-1.5 flex h-3 min-w-3 items-center justify-center rounded-full bg-primary px-0.5 text-[8px] font-medium leading-none text-primary-foreground tabular-nums ring-1 ring-sidebar">
                {unread > 9 ? "9+" : unread}
              </span>
            )}
          </span>
          <span
            className={cn(
              "text-xs truncate transition-all duration-200",
              collapsed ? "max-w-0 opacity-0 flex-none" : "flex-1 max-w-[600px] opacity-100",
            )}
          >
            {displayTitle}
          </span>
          {!collapsed && (
            <>
              {/* Fade so the close button stays legible over a long title */}
              <div
                className={cn(
                  "pointer-events-none absolute right-0 top-0 bottom-0 w-12 rounded-r-lg bg-gradient-to-l to-transparent opacity-0 transition-opacity group-hover:opacity-100",
                  active ? "from-sidebar-accent" : "from-accent",
                )}
              />
              <button
                className="hidden group-hover:flex absolute right-2 text-muted-foreground hover:text-foreground"
                onClick={(e) => {
                  e.stopPropagation()
                  onClose()
                }}
                onPointerDown={(e) => e.stopPropagation()}
                type="button"
              >
                <HugeiconsIcon className="size-3" icon={Cancel01Icon} />
              </button>
            </>
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent className="max-w-[300px]" side={collapsed ? "right" : "bottom"}>
        <p className="text-xs">{displayTitle}</p>
      </TooltipContent>
    </Tooltip>
  )
}

function BookmarkFavicon({ favicon }: { favicon?: string }) {
  if (favicon) {
    return (
      <img
        alt=""
        aria-hidden="true"
        className="size-4 rounded-sm shrink-0"
        onError={(e) => {
          ;(e.target as HTMLImageElement).style.display = "none"
        }}
        src={favicon}
      />
    )
  }
  return <HugeiconsIcon className="size-4 shrink-0 text-muted-foreground" icon={Globe02Icon} />
}
