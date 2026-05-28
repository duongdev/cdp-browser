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
import {
  arrayMove,
  rectSortingStrategy,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import {
  ArrowRight01Icon,
  Cancel01Icon,
  CloudIcon,
  Edit02Icon,
  Globe02Icon,
  Home01Icon,
  LaptopIcon,
  PinIcon,
  PinOffIcon,
  PlusSignIcon,
  SidebarLeft01Icon,
  SidebarLeftIcon,
} from "@hugeicons/core-free-icons"
import type { IconSvgElement } from "@hugeicons/react"
import { HugeiconsIcon } from "@hugeicons/react"
import { AnimatePresence, motion } from "motion/react"
import { type PointerEvent as ReactPointerEvent, useState } from "react"
import type { TabInfo } from "@/app"
import { InstallBanner } from "@/components/install-banner"
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
import { getCaps } from "@/lib/cdp-web-transport"
import type { LocalTab } from "@/lib/local-tabs"
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
  localTabs: LocalTab[]
  localActiveId: string | null
  onNewLocalTab: () => void
  onSwitchLocalTab: (id: string) => void
  onCloseLocalTab: (id: string) => void
  onToggleLocalPin: (id: string) => void
  onEditLocalTab: (id: string) => void
  onReorderLocalTabs: (tabs: LocalTab[]) => void
  showNumbers: boolean
}

const MIN_WIDTH = 180
const MAX_WIDTH = 480
// Wide enough to clear the macOS traffic lights in the collapsed rail.
const RAIL_WIDTH = 64
const PINNED_ZONE_ID = "pinned-zone"
const ROW_PRESENCE = {
  initial: { opacity: 0, height: 0 },
  animate: { opacity: 1, height: "auto" as const },
  exit: { opacity: 0, height: 0 },
  transition: { duration: 0.16, ease: "easeOut" as const },
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
  localTabs,
  localActiveId,
  onNewLocalTab,
  onSwitchLocalTab,
  onCloseLocalTab,
  onToggleLocalPin,
  onEditLocalTab,
  onReorderLocalTabs,
  showNumbers,
}: SidebarProps) {
  const caps = getCaps()
  // Cmd+number jump order (pins → CDP → local); first 9 get a hint badge.
  const numberOf = (key: string): number | undefined => {
    if (!showNumbers) return undefined
    const order = [
      ...pins.map((p) => `pin:${p.id}`),
      ...tabs.map((t) => `tab:${t.id}`),
      ...localTabs.map((t) => `local:${t.id}`),
    ]
    const i = order.indexOf(key)
    return i >= 0 && i < 9 ? i + 1 : undefined
  }
  const [resizing, setResizing] = useState(false)
  const [activeDragId, setActiveDragId] = useState<string | null>(null)
  const [localDragId, setLocalDragId] = useState<string | null>(null)
  const [pendingUnpin, setPendingUnpin] = useState<Pin | null>(null)

  // Accordion folder open-state + the tab "kept" visible when a folder collapses
  // (captured at collapse time; not updated when the active tab later changes).
  const [openCdp, setOpenCdp] = useState(true)
  const [openLocal, setOpenLocal] = useState(true)
  const [keptCdpId, setKeptCdpId] = useState<string | null>(null)
  const [keptLocalId, setKeptLocalId] = useState<string | null>(null)

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

  const handleDragStart = (event: DragStartEvent) => setActiveDragId(event.active.id as string)

  // One DndContext spans pinned + CDP tabs so a tab can be dragged up to pin it.
  const handleDragEnd = (event: DragEndEvent) => {
    setActiveDragId(null)
    const { active, over } = event
    if (!over) return
    const activeId = active.id as string
    const overId = over.id as string

    const draggedTab = tabs.find((t) => t.id === activeId)
    if (draggedTab) {
      const droppedInPinned = overId === PINNED_ZONE_ID || pins.some((p) => p.id === overId)
      if (droppedInPinned) onPinTab(draggedTab)
      else if (activeId !== overId) {
        const oldIndex = tabs.findIndex((t) => t.id === activeId)
        const newIndex = tabs.findIndex((t) => t.id === overId)
        if (newIndex !== -1) onReorderTabs(arrayMove(tabs, oldIndex, newIndex))
      }
      return
    }
    if (pins.some((p) => p.id === activeId) && activeId !== overId) {
      const oldIndex = pins.findIndex((p) => p.id === activeId)
      const newIndex = pins.findIndex((p) => p.id === overId)
      if (newIndex !== -1) onReorderPins(arrayMove(pins, oldIndex, newIndex))
    }
  }

  const handleLocalDragEnd = (event: DragEndEvent) => {
    setLocalDragId(null)
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = localTabs.findIndex((t) => t.id === active.id)
    const newIndex = localTabs.findIndex((t) => t.id === over.id)
    if (oldIndex !== -1 && newIndex !== -1)
      onReorderLocalTabs(arrayMove(localTabs, oldIndex, newIndex))
  }
  const overlayLocal = localDragId ? localTabs.find((t) => t.id === localDragId) : undefined

  const requestUnpin = (p: Pin) => {
    if (p.targetId != null) onUnpinPin(p.id)
    else setPendingUnpin(p)
  }

  // Capture the active tab of a folder's kind at the moment it collapses.
  const toggleCdp = () => {
    setOpenCdp((open) => {
      if (open) setKeptCdpId(activeTabId)
      return !open
    })
  }
  const toggleLocal = () => {
    setOpenLocal((open) => {
      if (open) setKeptLocalId(localActiveId)
      return !open
    })
  }

  const overlayPin = activeDragId ? pins.find((p) => p.id === activeDragId) : undefined
  const overlayTab = activeDragId ? tabs.find((t) => t.id === activeDragId) : undefined

  return (
    <div
      className={cn(
        "relative flex flex-col shrink-0 min-w-0 bg-sidebar",
        !resizing && "transition-[width] duration-200",
      )}
      style={{ width: collapsed ? RAIL_WIDTH : width }}
    >
      <div className="pointer-events-none absolute right-0 top-11 bottom-0 w-px bg-sidebar-border" />
      <div
        className={cn(
          "pointer-events-none absolute right-0 top-0 h-11 w-px bg-sidebar-border transition-opacity duration-200",
          collapsed ? "opacity-0" : "opacity-100",
        )}
      />

      {!collapsed && (
        <div
          className="absolute -right-1 top-0 bottom-0 z-20 w-2 cursor-col-resize hover:bg-primary/30"
          onPointerDown={handleResizeStart}
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        />
      )}

      {/* Traffic-light drag region. Collapse control is top-right (clear of the
          left traffic lights); the expand control lives inside the rail when
          collapsed, so nothing overlaps the lights. */}
      <div
        className="h-11 shrink-0 relative border-b border-border bg-card"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      >
        {!collapsed && (
          <div
            className="absolute top-2.5 right-2 z-10"
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

      {collapsed ? (
        <CollapsedRail
          activeTabId={activeTabId}
          localActiveId={localActiveId}
          localTabs={localTabs}
          onActivatePin={onActivatePin}
          onExpand={onToggleCollapse}
          onNewTab={onNewTab}
          onSwitchLocalTab={onSwitchLocalTab}
          onSwitchTab={onSwitchTab}
          pins={pins}
          showNumbers={showNumbers}
          tabs={tabs}
          unreadByPin={unreadByPin}
          unreadByTab={unreadByTab}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overflow-x-hidden px-2 pt-1 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          <InstallBanner />
          <DndContext
            collisionDetection={closestCenter}
            onDragCancel={() => setActiveDragId(null)}
            onDragEnd={handleDragEnd}
            onDragStart={handleDragStart}
            sensors={sensors}
          >
            {/* Pinned tile grid — fixed-size tiles, centered, wraps with width */}
            <PinnedZone draggingTab={draggingTabId !== null} empty={pins.length === 0}>
              <SortableContext items={pins.map((p) => p.id)} strategy={rectSortingStrategy}>
                <div className="flex flex-wrap justify-center gap-1.5">
                  {pins.map((p) => (
                    <SortablePinTile
                      active={p.targetId != null && p.targetId === activeTabId}
                      key={p.id}
                      linkedTab={linkedTabByPin[p.id]}
                      number={numberOf(`pin:${p.id}`)}
                      onActivate={() => onActivatePin(p)}
                      onBackToPinned={() => onBackToPinnedUrl(p)}
                      onClose={() => onClosePin(p)}
                      onEdit={() => onEditPin(p)}
                      onOpenInNewTab={() => onOpenPinInNewTab(p)}
                      onUnpin={() => requestUnpin(p)}
                      pin={p}
                      unread={unreadByPin[p.id] || 0}
                    />
                  ))}
                </div>
              </SortableContext>
            </PinnedZone>
            {pins.length > 0 && <div className="mx-1 mb-0.5 border-b border-sidebar-border/70" />}

            {/* CDP Tabs folder */}
            <Folder
              count={tabs.length}
              icon={CloudIcon}
              label="CDP Tabs"
              onNew={onNewTab}
              onToggle={toggleCdp}
              open={openCdp}
            >
              {/* SortableContext always receives the full id list so dnd-kit hooks
                  never remount. AnimatePresence filters to kept-only when collapsed:
                  the kept row keeps the same key so it stays mounted (no exit/enter),
                  while all other rows animate their height to 0. */}
              <SortableContext items={tabs.map((t) => t.id)} strategy={verticalListSortingStrategy}>
                <AnimatePresence initial={false}>
                  {tabs
                    .filter((tab) => openCdp || tab.id === keptCdpId)
                    .map((tab) => {
                      const index = tabs.indexOf(tab)
                      return (
                        <SortableTabItem
                          active={tab.id === activeTabId}
                          canCloseAbove={index > 0}
                          canCloseBelow={index < tabs.length - 1}
                          canCloseOthers={tabs.length > 1}
                          key={tab.id}
                          number={numberOf(`tab:${tab.id}`)}
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
                      )
                    })}
                </AnimatePresence>
              </SortableContext>
            </Folder>

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

          {/* Local Tabs folder — Electron only (web build hides it via capabilities) */}
          {caps.localTabs && (
            <DndContext
              collisionDetection={closestCenter}
              onDragCancel={() => setLocalDragId(null)}
              onDragEnd={handleLocalDragEnd}
              onDragStart={(e) => setLocalDragId(e.active.id as string)}
              sensors={sensors}
            >
              <Folder
                count={localTabs.length}
                icon={LaptopIcon}
                label="Local Tabs"
                onNew={onNewLocalTab}
                onToggle={toggleLocal}
                open={openLocal}
              >
                <SortableContext
                  items={localTabs.map((t) => t.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <AnimatePresence initial={false}>
                    {localTabs
                      .filter((tab) => openLocal || tab.id === keptLocalId)
                      .map((tab) => (
                        <SortableLocalItem
                          active={tab.id === localActiveId}
                          key={tab.id}
                          number={numberOf(`local:${tab.id}`)}
                          onClose={() => onCloseLocalTab(tab.id)}
                          onEdit={() => onEditLocalTab(tab.id)}
                          onSwitch={() => onSwitchLocalTab(tab.id)}
                          onTogglePin={() => onToggleLocalPin(tab.id)}
                          tab={tab}
                        />
                      ))}
                  </AnimatePresence>
                </SortableContext>
              </Folder>
              <DragOverlay dropAnimation={null}>
                {overlayLocal ? (
                  <RowShell>
                    <RowFavicon favicon={overlayLocal.favicon} />
                    <RowLabel>{overlayLocal.title || "New Tab"}</RowLabel>
                  </RowShell>
                ) : null}
              </DragOverlay>
            </DndContext>
          )}
        </div>
      )}

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

// --- Accordion folder (CDP / Local) ---

function Folder({
  icon,
  label,
  count,
  open,
  onToggle,
  onNew,
  children,
}: {
  icon: IconSvgElement
  label: string
  count: number
  open: boolean
  onToggle: () => void
  onNew: () => void
  children: React.ReactNode
}) {
  return (
    <div className="flex shrink-0 flex-col">
      {/* Header — same px-2.5/gap-2/size-4 slot as rows, so the leading icon
          aligns with row favicons and the label with row titles. */}
      <div className="group/folder flex items-center rounded-lg pr-1">
        <button
          className="flex flex-1 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left outline-none"
          onClick={onToggle}
          type="button"
        >
          <span className="relative grid size-4 shrink-0 place-items-center">
            <HugeiconsIcon
              className="size-3.5 text-muted-foreground/70 transition-opacity duration-150 group-hover/folder:opacity-0"
              icon={icon}
            />
            <HugeiconsIcon
              className={cn(
                "absolute size-3 text-muted-foreground opacity-0 transition-all duration-150 group-hover/folder:opacity-100",
                open && "rotate-90",
              )}
              icon={ArrowRight01Icon}
            />
          </span>
          <span className="flex-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground select-none">
            {label}
          </span>
          <span className="text-[10px] font-medium tabular-nums text-muted-foreground/45">
            {count}
          </span>
        </button>
        <Button
          aria-label="New tab"
          className="shrink-0 text-muted-foreground/70 hover:text-foreground"
          onClick={onNew}
          size="icon-xs"
          variant="ghost"
        >
          <HugeiconsIcon className="size-3.5" icon={PlusSignIcon} />
        </Button>
      </div>
      <div className="space-y-0.5 pb-1">{children}</div>
    </div>
  )
}

// --- Collapsed icon rail (markers) ---

function CollapsedRail({
  pins,
  tabs,
  localTabs,
  activeTabId,
  localActiveId,
  unreadByPin,
  unreadByTab,
  onActivatePin,
  onSwitchTab,
  onSwitchLocalTab,
  onNewTab,
  onExpand,
  showNumbers,
}: {
  pins: Pin[]
  tabs: TabInfo[]
  localTabs: LocalTab[]
  activeTabId: string | null
  localActiveId: string | null
  unreadByPin: Record<string, number>
  unreadByTab: Record<string, number>
  onActivatePin: (pin: Pin) => void
  onSwitchTab: (id: string) => void
  onSwitchLocalTab: (id: string) => void
  onNewTab: () => void
  onExpand: () => void
  showNumbers: boolean
}) {
  // Same Cmd+number order as the expanded sidebar: pins → CDP → local.
  const order = [
    ...pins.map((p) => `pin:${p.id}`),
    ...tabs.map((t) => `tab:${t.id}`),
    ...localTabs.map((t) => `local:${t.id}`),
  ]
  const numberOf = (key: string): number | undefined => {
    if (!showNumbers) return undefined
    const i = order.indexOf(key)
    return i >= 0 && i < 9 ? i + 1 : undefined
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto overflow-x-hidden pt-2 pb-2">
      {/* Expand control — below the traffic-light region so it never overlaps. */}
      <Tooltip delayDuration={0}>
        <TooltipTrigger asChild>
          <button
            className="mb-0.5 grid size-7 place-items-center rounded-md text-muted-foreground/70 hover:bg-foreground/[0.06] hover:text-foreground"
            onClick={onExpand}
            type="button"
          >
            <HugeiconsIcon className="size-3.5" icon={SidebarLeftIcon} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">Expand sidebar</TooltipContent>
      </Tooltip>
      {pins.map((p) => (
        <RailTile
          active={p.targetId != null && p.targetId === activeTabId}
          favicon={linkedFavicon(p)}
          key={p.id}
          number={numberOf(`pin:${p.id}`)}
          onClick={() => onActivatePin(p)}
          title={p.title}
          unread={unreadByPin[p.id] || 0}
        />
      ))}
      {tabs.length > 0 && <RailMarker icon={CloudIcon} />}
      {tabs.map((t) => (
        <RailTile
          active={t.id === activeTabId}
          favicon={t.faviconUrl}
          key={t.id}
          number={numberOf(`tab:${t.id}`)}
          onClick={() => onSwitchTab(t.id)}
          title={t.title || "New Tab"}
          unread={unreadByTab[t.id] || 0}
        />
      ))}
      {localTabs.length > 0 && <RailMarker icon={LaptopIcon} />}
      {localTabs.map((t) => (
        <RailTile
          active={t.id === localActiveId}
          favicon={t.favicon}
          key={t.id}
          number={numberOf(`local:${t.id}`)}
          onClick={() => onSwitchLocalTab(t.id)}
          pinned={t.pinned}
          title={t.title || "New Tab"}
        />
      ))}
      <div className="mt-auto pt-1">
        <Tooltip delayDuration={0}>
          <TooltipTrigger asChild>
            <button
              className="grid size-9 place-items-center rounded-[10px] text-muted-foreground/70 ring-1 ring-inset ring-border/60 hover:bg-foreground/[0.06] hover:text-foreground"
              onClick={onNewTab}
              type="button"
            >
              <HugeiconsIcon className="size-4" icon={PlusSignIcon} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">New tab</TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}

function RailMarker({ icon }: { icon: IconSvgElement }) {
  return <HugeiconsIcon className="my-0.5 size-3.5 shrink-0 text-muted-foreground/45" icon={icon} />
}

function RailTile({
  favicon,
  title,
  active,
  unread = 0,
  pinned,
  number,
  onClick,
}: {
  favicon?: string
  title: string
  active?: boolean
  unread?: number
  pinned?: boolean
  number?: number
  onClick: () => void
}) {
  return (
    <Tooltip delayDuration={0}>
      <TooltipTrigger asChild>
        <button
          className={cn(
            "group relative grid size-9 shrink-0 place-items-center rounded-[10px] transition-all duration-150",
            active
              ? "bg-foreground/10 shadow-sm ring-1 ring-inset ring-border/70"
              : "hover:bg-foreground/[0.06]",
          )}
          onClick={onClick}
          type="button"
        >
          {active && (
            <span className="absolute -left-2 top-1/2 h-4 w-[2.5px] -translate-y-1/2 rounded-full bg-primary" />
          )}
          <span className="relative">
            <RowFavicon favicon={favicon} />
            <UnreadBadge count={unread} />
            <NumberHint n={number} />
          </span>
          {pinned && (
            <span className="absolute bottom-0.5 right-0.5 size-1.5 rounded-full bg-foreground/40 ring-1 ring-sidebar" />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">{title}</TooltipContent>
    </Tooltip>
  )
}

function linkedFavicon(pin: Pin) {
  return pin.favicon
}

// --- Pinned drop zone ---

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
    <div className="shrink-0 pb-0.5 pt-1" ref={setNodeRef}>
      {empty ? (
        draggingTab ? (
          <div
            className={cn(
              "rounded-lg border border-dashed px-2.5 py-3 text-center text-[11px] text-muted-foreground transition-colors duration-200",
              isOver ? "border-primary/60 bg-primary/5 text-foreground" : "border-border",
            )}
          >
            Drop to pin
          </div>
        ) : null
      ) : (
        <div
          className={cn(
            "rounded-xl transition-colors duration-200",
            draggingTab && isOver && "bg-primary/5 ring-1 ring-primary/40",
          )}
        >
          {children}
        </div>
      )}
    </div>
  )
}

// --- shared row visuals ---

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

// Slack-style jump number, overlaid on the favicon while Cmd is held.
function NumberHint({ n }: { n?: number }) {
  if (n == null) return null
  return (
    <span className="absolute inset-0 z-10 grid place-items-center rounded-[5px] bg-foreground/80 text-[10px] font-bold leading-none text-background">
      {n}
    </span>
  )
}

function sortableStyle(
  transform: ReturnType<typeof useSortable>["transform"],
  transition?: string,
) {
  return { transform: CSS.Transform.toString(transform), transition }
}

// --- Sortable Pin Tile (favicon-only grid cell) ---

function SortablePinTile({
  pin,
  linkedTab,
  active,
  unread,
  number,
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
  unread: number
  number?: number
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
  const title = linkedTab?.title || pin.title
  const favicon = linkedTab?.faviconUrl ?? pin.favicon
  const showDrift = active && linkedTab != null && linkedTab.url !== pin.url

  return (
    <Tooltip delayDuration={500} open={menuOpen ? false : undefined}>
      <ContextMenu onOpenChange={setMenuOpen}>
        <ContextMenuTrigger asChild>
          <TooltipTrigger asChild>
            <button
              className={cn(
                "group relative grid size-9 place-items-center rounded-[11px] transition-all duration-150 cursor-default",
                isDragging
                  ? "opacity-50"
                  : active
                    ? "bg-foreground/[0.10] shadow-sm ring-1 ring-inset ring-border/70"
                    : "hover:bg-foreground/[0.06]",
              )}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault()
                  onOpenInNewTab()
                }
              }}
              onClick={(e) => (e.metaKey ? onOpenInNewTab() : onActivate())}
              ref={setNodeRef}
              style={sortableStyle(transform, transition)}
              type="button"
              {...attributes}
              {...listeners}
            >
              <span className="relative size-5 group/fav">
                <span className={cn("block", showDrift && "group-hover/fav:opacity-0")}>
                  <img
                    alt=""
                    aria-hidden
                    className="size-5 rounded-[5px]"
                    onError={(e) => {
                      ;(e.target as HTMLImageElement).style.visibility = "hidden"
                    }}
                    src={favicon}
                  />
                </span>
                {showDrift && (
                  <span
                    aria-label="Back to pinned URL"
                    className="absolute inset-0 hidden place-items-center rounded-[5px] bg-foreground/15 text-foreground group-hover/fav:grid"
                    onClick={(e) => {
                      e.stopPropagation()
                      onBackToPinned()
                    }}
                    onKeyDown={(e) => e.key === "Enter" && onBackToPinned()}
                    onPointerDown={(e) => e.stopPropagation()}
                    role="button"
                    tabIndex={-1}
                  >
                    <HugeiconsIcon className="size-3" icon={Home01Icon} />
                  </span>
                )}
                <UnreadBadge count={unread} />
                <NumberHint n={number} />
              </span>
            </button>
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
        <p className="text-xs font-medium line-clamp-2">{title}</p>
        <p className="text-[10px] text-background/60 break-all line-clamp-2">
          {linkedTab?.url || pin.url}
        </p>
      </TooltipContent>
    </Tooltip>
  )
}

// --- Sortable Tab Item (CDP) ---

function SortableTabItem({
  tab,
  active,
  unread,
  number,
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
  unread: number
  number?: number
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
                  "group relative flex items-center gap-2 rounded-lg px-2.5 py-1.5 cursor-default",
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
                  <NumberHint n={number} />
                </span>
                <span className="flex-1 truncate text-xs">{displayTitle}</span>
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
        <TooltipContent className="max-w-[300px]" side="bottom">
          <p className="text-xs line-clamp-2">{displayTitle}</p>
        </TooltipContent>
      </Tooltip>
    </motion.div>
  )
}

// --- Sortable Local Item ---

function SortableLocalItem({
  tab,
  active,
  number,
  onSwitch,
  onClose,
  onTogglePin,
  onEdit,
}: {
  tab: LocalTab
  active: boolean
  number?: number
  onSwitch: () => void
  onClose: () => void
  onTogglePin: () => void
  onEdit: () => void
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
                  "group relative flex items-center gap-2 rounded-lg px-2.5 py-1.5 cursor-default",
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
                  <RowFavicon favicon={tab.favicon} />
                  <NumberHint n={number} />
                </span>
                <span className="flex-1 truncate text-xs">{displayTitle}</span>
                {/* pin indicator on the right so favicons + titles stay aligned */}
                {tab.pinned && (
                  <HugeiconsIcon
                    className="size-3 shrink-0 text-muted-foreground/50 group-hover:hidden"
                    icon={PinIcon}
                  />
                )}
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
              </div>
            </TooltipTrigger>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem onSelect={onEdit}>
              <HugeiconsIcon icon={Edit02Icon} />
              Edit
            </ContextMenuItem>
            <ContextMenuItem onSelect={onTogglePin}>
              <HugeiconsIcon icon={tab.pinned ? PinOffIcon : PinIcon} />
              {tab.pinned ? "Unpin" : "Pin"}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={onClose} variant="destructive">
              <HugeiconsIcon icon={Cancel01Icon} />
              Close
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
        <TooltipContent className="max-w-[300px]" side="bottom">
          <p className="text-xs line-clamp-2">{displayTitle}</p>
        </TooltipContent>
      </Tooltip>
    </motion.div>
  )
}
