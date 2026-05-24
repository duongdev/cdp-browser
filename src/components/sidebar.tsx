import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core"
import { restrictToVerticalAxis } from "@dnd-kit/modifiers"
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
  Edit02Icon,
  Globe02Icon,
  Home01Icon,
  PinIcon,
  PinOffIcon,
  PlusSignIcon,
  SidebarLeft01Icon,
  SidebarLeftIcon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { AnimatePresence, motion } from "motion/react"
import { type PointerEvent as ReactPointerEvent, useState } from "react"
import type { TabInfo } from "@/app"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

interface SidebarProps {
  tabs: TabInfo[]
  activeTabId: string | null
  unreadByTab: Record<string, number>
  unreadByPin: Record<string, number>
  linkedTabByPin: Record<string, TabInfo>
  onSwitchTab: (id: string) => void
  onCloseTab: (id: string) => void
  onCloseTabs: (ids: string[]) => void
  onNewTab: () => void
  collapsed: boolean
  onToggleCollapse: () => void
  width: number
  onResize: (width: number) => void
  onResizeEnd: (width: number) => void
  pinnedOpen: boolean
  onPinnedToggle: () => void
  pins: Pin[]
  onActivatePin: (pin: Pin) => void
  onOpenPinInNewTab: (pin: Pin) => void
  onBackToPinnedUrl: (pin: Pin) => void
  onEditPin: (pin: Pin) => void
  onUnpinPin: (id: string) => void
  onClosePin: (pin: Pin) => void
  onPinTab: (tab: TabInfo) => void
  onReorderPins: (pins: Pin[]) => void
  onReorderTabs: (tabs: TabInfo[]) => void
}

const MIN_WIDTH = 180
const MAX_WIDTH = 480
const PINNED_ZONE_ID = "pinned-zone"
const ROW_PRESENCE = {
  initial: { opacity: 0, height: 0 },
  animate: { opacity: 1, height: "auto" as const },
  exit: { opacity: 0, height: 0 },
  transition: { duration: 0.18, ease: "easeOut" as const },
}

export function Sidebar({
  tabs,
  activeTabId,
  unreadByTab,
  unreadByPin,
  linkedTabByPin,
  onSwitchTab,
  onCloseTab,
  onCloseTabs,
  onNewTab,
  collapsed,
  onToggleCollapse,
  width,
  onResize,
  onResizeEnd,
  pinnedOpen,
  onPinnedToggle,
  pins,
  onActivatePin,
  onOpenPinInNewTab,
  onBackToPinnedUrl,
  onEditPin,
  onUnpinPin,
  onClosePin,
  onPinTab,
  onReorderPins,
  onReorderTabs,
}: SidebarProps) {
  const [resizing, setResizing] = useState(false)
  // The id of the row being dragged (pin id or tab id), rendered in the overlay.
  const [activeDragId, setActiveDragId] = useState<string | null>(null)
  // Pin awaiting un-pin confirmation.
  const [pendingUnpin, setPendingUnpin] = useState<Pin | null>(null)

  const draggingTabId =
    activeDragId && tabs.some((t) => t.id === activeDragId) ? activeDragId : null

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

  const handleDragStart = (event: DragStartEvent) => {
    setActiveDragId(event.active.id as string)
  }

  // One DndContext spans both sections so a tab can be dragged up into Pinned.
  // The drag's source decides the action: pin reorder, tab reorder, or pin-a-tab.
  const handleDragEnd = (event: DragEndEvent) => {
    setActiveDragId(null)
    const { active, over } = event
    if (!over) return
    const activeId = active.id as string
    const overId = over.id as string

    const draggedTab = tabs.find((t) => t.id === activeId)
    if (draggedTab) {
      const droppedInPinned = overId === PINNED_ZONE_ID || pins.some((p) => p.id === overId)
      if (droppedInPinned) {
        onPinTab(draggedTab)
      } else if (activeId !== overId) {
        const oldIndex = tabs.findIndex((t) => t.id === activeId)
        const newIndex = tabs.findIndex((t) => t.id === overId)
        if (newIndex !== -1) onReorderTabs(arrayMove(tabs, oldIndex, newIndex))
      }
      return
    }

    // Dragging a pin — reorder within Pinned only (ignore drops onto the Tabs list).
    if (pins.some((p) => p.id === activeId) && activeId !== overId) {
      const oldIndex = pins.findIndex((p) => p.id === activeId)
      const newIndex = pins.findIndex((p) => p.id === overId)
      if (newIndex !== -1) onReorderPins(arrayMove(pins, oldIndex, newIndex))
    }
  }

  // Collapsing the Pinned section keeps pins that hold a live tab visible — only
  // dormant pins are hidden.
  const visiblePins = pinnedOpen || collapsed ? pins : pins.filter((p) => p.targetId != null)
  const showPinnedSection = pins.length > 0 || draggingTabId !== null

  const overlayPin = activeDragId ? pins.find((p) => p.id === activeDragId) : undefined
  const overlayTab = activeDragId ? tabs.find((t) => t.id === activeDragId) : undefined

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

      <DndContext
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis]}
        onDragCancel={() => setActiveDragId(null)}
        onDragEnd={handleDragEnd}
        onDragStart={handleDragStart}
        sensors={sensors}
      >
        {/* Pinned section */}
        {showPinnedSection && (
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
            <PinnedZone draggingTab={draggingTabId !== null} empty={pins.length === 0}>
              <SortableContext items={pins.map((p) => p.id)} strategy={verticalListSortingStrategy}>
                <div className="space-y-0.5">
                  <AnimatePresence initial={false}>
                    {visiblePins.map((p) => (
                      <SortablePinItem
                        active={p.targetId != null && p.targetId === activeTabId}
                        collapsed={collapsed}
                        key={p.id}
                        linkedTab={linkedTabByPin[p.id]}
                        onActivate={() => onActivatePin(p)}
                        onBackToPinned={() => onBackToPinnedUrl(p)}
                        onClose={() => onClosePin(p)}
                        onEdit={() => onEditPin(p)}
                        onOpenInNewTab={() => onOpenPinInNewTab(p)}
                        onUnpin={() => setPendingUnpin(p)}
                        pin={p}
                        unread={unreadByPin[p.id] || 0}
                      />
                    ))}
                  </AnimatePresence>
                </div>
              </SortableContext>
            </PinnedZone>
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
        {collapsed && showPinnedSection && (
          <div className="px-3 pt-1 pb-1 shrink-0">
            <div className="border-t border-sidebar-border" />
          </div>
        )}

        {/* Tab list */}
        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
          <SortableContext items={tabs.map((t) => t.id)} strategy={verticalListSortingStrategy}>
            <div className="space-y-0.5 px-2 py-1">
              <AnimatePresence initial={false}>
                {tabs.map((tab, index) => (
                  <SortableTabItem
                    active={tab.id === activeTabId}
                    canCloseAbove={index > 0}
                    canCloseBelow={index < tabs.length - 1}
                    canCloseOthers={tabs.length > 1}
                    collapsed={collapsed}
                    key={tab.id}
                    onClose={() => onCloseTab(tab.id)}
                    onCloseAbove={() => onCloseTabs(tabs.slice(0, index).map((t) => t.id))}
                    onCloseBelow={() => onCloseTabs(tabs.slice(index + 1).map((t) => t.id))}
                    onCloseOthers={() =>
                      onCloseTabs(tabs.filter((t) => t.id !== tab.id).map((t) => t.id))
                    }
                    onPin={() => onPinTab(tab)}
                    onSwitch={() => onSwitchTab(tab.id)}
                    tab={tab}
                    unread={unreadByTab[tab.id] || 0}
                  />
                ))}
              </AnimatePresence>
            </div>
          </SortableContext>
        </div>

        <DragOverlay dropAnimation={null}>
          {overlayPin ? (
            <RowShell>
              <RowFavicon favicon={overlayPin.favicon} />
              <RowLabel>{overlayPin.title}</RowLabel>
            </RowShell>
          ) : overlayTab ? (
            <RowShell>
              <RowFavicon favicon={overlayTab.faviconUrl} />
              <RowLabel>{overlayTab.title || "New Tab"}</RowLabel>
            </RowShell>
          ) : null}
        </DragOverlay>
      </DndContext>

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

      <AlertDialog
        onOpenChange={(open) => !open && setPendingUnpin(null)}
        open={pendingUnpin != null}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unpin “{pendingUnpin?.title}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The pin is removed from the sidebar. If it has an open tab, that tab moves back to the
              Tabs list — it isn’t closed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingUnpin) onUnpinPin(pendingUnpin.id)
                setPendingUnpin(null)
              }}
            >
              Unpin
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// --- Pinned drop zone ---

// Wraps the pinned list as a droppable so a tab dragged anywhere over the section
// becomes a pin. When empty (no pins yet) it shows a dashed prompt during a drag.
function PinnedZone({
  draggingTab,
  empty,
  children,
}: {
  draggingTab: boolean
  empty: boolean
  children: React.ReactNode
}) {
  const { setNodeRef, isOver } = useDroppable({ id: PINNED_ZONE_ID })

  return (
    <div className="px-2 pb-1" ref={setNodeRef}>
      {empty ? (
        <div
          className={cn(
            "rounded-lg border border-dashed px-2.5 py-2 text-center text-[11px] text-muted-foreground transition-colors duration-200",
            isOver ? "border-primary/60 bg-primary/5 text-foreground" : "border-border",
          )}
        >
          Drop to pin
        </div>
      ) : (
        <div
          className={cn(
            "rounded-lg transition-colors duration-200",
            draggingTab && isOver && "bg-primary/5 ring-1 ring-primary/40",
          )}
        >
          {children}
        </div>
      )}
    </div>
  )
}

// --- shared row visuals (also used by the drag overlay) ---

function RowShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-sidebar px-2.5 py-1.5 shadow-lg ring-1 ring-border">
      {children}
    </div>
  )
}

function RowLabel({ children }: { children: React.ReactNode }) {
  return <span className="text-xs truncate text-foreground">{children}</span>
}

function RowFavicon({ favicon }: { favicon?: string }) {
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

function UnreadBadge({ count }: { count: number }) {
  if (count <= 0) return null
  return (
    <span className="absolute -right-1.5 -top-1.5 flex h-3 min-w-3 items-center justify-center rounded-full bg-primary px-0.5 text-[8px] font-medium leading-none text-primary-foreground tabular-nums ring-1 ring-sidebar">
      {count > 9 ? "9+" : count}
    </span>
  )
}

// dnd-kit applies the live drag/reorder transform; motion only handles enter/exit
// on the outer wrapper, so the two never fight over the same transform.
function sortableStyle(
  transform: ReturnType<typeof useSortable>["transform"],
  transition?: string,
) {
  return {
    transform: CSS.Transform.toString(transform),
    transition,
  }
}

// --- Sortable Pin Item ---

function SortablePinItem({
  pin,
  linkedTab,
  active,
  collapsed,
  unread,
  onActivate,
  onOpenInNewTab,
  onBackToPinned,
  onEdit,
  onUnpin,
  onClose,
}: {
  pin: Pin
  linkedTab?: TabInfo
  active: boolean
  collapsed: boolean
  unread: number
  onActivate: () => void
  onOpenInNewTab: () => void
  onBackToPinned: () => void
  onEdit: () => void
  onUnpin: () => void
  onClose: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: pin.id,
  })
  const [menuOpen, setMenuOpen] = useState(false)

  // While linked, mirror the tab's live title/favicon; when dormant, show saved.
  const title = linkedTab?.title || pin.title
  const favicon = linkedTab?.faviconUrl ?? pin.favicon
  // Drift affordance is only shown for the active pin (the one you're viewing).
  const showDrift = active && linkedTab != null && linkedTab.url !== pin.url

  return (
    <motion.div
      animate={ROW_PRESENCE.animate}
      exit={ROW_PRESENCE.exit}
      initial={ROW_PRESENCE.initial}
      transition={ROW_PRESENCE.transition}
    >
      <Tooltip delayDuration={collapsed ? 0 : 600} open={menuOpen ? false : undefined}>
        <ContextMenu onOpenChange={setMenuOpen}>
          <ContextMenuTrigger asChild>
            <TooltipTrigger asChild>
              <div
                className={cn(
                  "group relative flex items-center rounded-lg cursor-default",
                  collapsed ? "px-2.5 py-1.5 gap-0" : "px-2.5 py-1.5 gap-2",
                  isDragging
                    ? "opacity-50"
                    : active
                      ? "bg-foreground/10 text-foreground shadow-sm"
                      : "text-sidebar-foreground hover:bg-foreground/[0.06] hover:text-foreground",
                )}
                onAuxClick={(e) => {
                  if (e.button === 1) {
                    e.preventDefault()
                    onOpenInNewTab()
                  }
                }}
                onClick={(e) => {
                  // Cmd-click opens an independent throwaway tab, leaving the pin alone.
                  if (e.metaKey) onOpenInNewTab()
                  else onActivate()
                }}
                ref={setNodeRef}
                style={sortableStyle(transform, transition)}
                {...attributes}
                {...listeners}
              >
                {/* Favicon — turns into a "Back to Pinned URL" button on hover when
                    the active pin's tab has drifted from the saved URL. */}
                <span className="relative shrink-0 size-4 group/fav">
                  <span className={cn(showDrift && "group-hover/fav:opacity-0")}>
                    <RowFavicon favicon={favicon} />
                  </span>
                  {showDrift && (
                    <button
                      aria-label="Back to pinned URL"
                      className="absolute inset-0 hidden place-items-center rounded-sm bg-foreground/10 text-foreground group-hover/fav:grid"
                      onClick={(e) => {
                        e.stopPropagation()
                        onBackToPinned()
                      }}
                      onPointerDown={(e) => e.stopPropagation()}
                      type="button"
                    >
                      <HugeiconsIcon className="size-3" icon={Home01Icon} />
                    </button>
                  )}
                  <UnreadBadge count={unread} />
                </span>
                {/* Drift separator (Arc-style) between favicon and title. */}
                {showDrift && !collapsed && (
                  <span className="text-muted-foreground/70 text-xs select-none -mx-0.5">/</span>
                )}
                <span
                  className={cn(
                    "text-xs truncate transition-all duration-200",
                    collapsed ? "max-w-0 opacity-0 flex-none" : "flex-1 max-w-[600px] opacity-100",
                  )}
                >
                  {title}
                </span>
                {/* Hover affordance: close the live tab, or un-pin a dormant pin. */}
                {!collapsed &&
                  (pin.targetId != null ? (
                    <button
                      aria-label="Close tab"
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
                  ) : (
                    <button
                      aria-label="Unpin"
                      className="hidden group-hover:flex absolute right-2 text-muted-foreground hover:text-foreground"
                      onClick={(e) => {
                        e.stopPropagation()
                        onUnpin()
                      }}
                      onPointerDown={(e) => e.stopPropagation()}
                      type="button"
                    >
                      <HugeiconsIcon className="size-3" icon={PinOffIcon} />
                    </button>
                  ))}
              </div>
            </TooltipTrigger>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem onSelect={onEdit}>
              <HugeiconsIcon icon={Edit02Icon} />
              Edit
            </ContextMenuItem>
            {pin.targetId != null && (
              <ContextMenuItem onSelect={onClose}>
                <HugeiconsIcon icon={Cancel01Icon} />
                Close tab
              </ContextMenuItem>
            )}
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={onUnpin} variant="destructive">
              <HugeiconsIcon icon={PinOffIcon} />
              Unpin
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
        <TooltipContent className="max-w-[260px]" side="right">
          <div className="flex flex-col gap-0.5">
            <p className="text-xs font-medium line-clamp-2">{title}</p>
            {!collapsed && (
              <p className="text-[10px] text-background/60 break-all line-clamp-2">
                {linkedTab?.url || pin.url}
              </p>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </motion.div>
  )
}

// --- Sortable Tab Item ---

function SortableTabItem({
  tab,
  active,
  collapsed,
  unread,
  canCloseOthers,
  canCloseAbove,
  canCloseBelow,
  onSwitch,
  onClose,
  onPin,
  onCloseOthers,
  onCloseAbove,
  onCloseBelow,
}: {
  tab: TabInfo
  active: boolean
  collapsed: boolean
  unread: number
  canCloseOthers: boolean
  canCloseAbove: boolean
  canCloseBelow: boolean
  onSwitch: () => void
  onClose: () => void
  onPin: () => void
  onCloseOthers: () => void
  onCloseAbove: () => void
  onCloseBelow: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tab.id,
  })
  const [menuOpen, setMenuOpen] = useState(false)

  const displayTitle = tab.title || "New Tab"

  return (
    <motion.div
      animate={ROW_PRESENCE.animate}
      exit={ROW_PRESENCE.exit}
      initial={ROW_PRESENCE.initial}
      transition={ROW_PRESENCE.transition}
    >
      <Tooltip delayDuration={600} open={menuOpen ? false : undefined}>
        <ContextMenu onOpenChange={setMenuOpen}>
          <ContextMenuTrigger asChild>
            <TooltipTrigger asChild>
              <div
                className={cn(
                  "group relative flex items-center rounded-lg cursor-default",
                  collapsed ? "px-2.5 py-1.5 gap-0" : "px-2.5 py-1.5 gap-2",
                  isDragging
                    ? "opacity-50"
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
                ref={setNodeRef}
                style={sortableStyle(transform, transition)}
                {...attributes}
                {...listeners}
              >
                <span className="relative shrink-0">
                  <RowFavicon favicon={tab.faviconUrl} />
                  <UnreadBadge count={unread} />
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
                      aria-label="Close tab"
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
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem onSelect={onPin}>
              <HugeiconsIcon icon={PinIcon} />
              Pin
            </ContextMenuItem>
            <ContextMenuItem onSelect={onClose}>
              <HugeiconsIcon icon={Cancel01Icon} />
              Close
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem disabled={!canCloseOthers} onSelect={onCloseOthers}>
              Close other tabs
            </ContextMenuItem>
            <ContextMenuItem disabled={!canCloseAbove} onSelect={onCloseAbove}>
              Close tabs above
            </ContextMenuItem>
            <ContextMenuItem disabled={!canCloseBelow} onSelect={onCloseBelow}>
              Close tabs below
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
        <TooltipContent className="max-w-[300px]" side={collapsed ? "right" : "bottom"}>
          <p className="text-xs line-clamp-2">{displayTitle}</p>
        </TooltipContent>
      </Tooltip>
    </motion.div>
  )
}
