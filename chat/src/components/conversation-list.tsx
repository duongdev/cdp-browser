import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core"
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { Alert02Icon, ArrowRight01Icon, InboxIcon, ReloadIcon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { mergeConversations } from "../lib/conversation-merge"
import {
  applyPrefs,
  applyReadOverride,
  CHATS_FOLDER,
  type ConvPrefs,
  type FolderSection,
  filterConversations,
  folderLabel,
  groupByFolder,
  type ListFilter,
  type ReadOverride,
} from "../lib/conversation-view"
import type { NamePref } from "../lib/display-name"
import { fetchConversations, TeamsApiError, type TeamsConversation } from "../lib/teams-client"
import type { ConvPrefsPatch } from "../lib/use-conv-prefs"
import { ConversationRow } from "./conversation-row"
import { ConversationRowMenu } from "./conversation-row-menu"

// Live sync (t135, poll-first): cadence for re-unioning the newest conversation page.
const LIST_POLL_MS = 12_000
// Live "ago" tick (t168): one list-level timer re-renders the relative times, so "5m" can't go
// stale between polls. 30s matches the display granularity (minutes).
const TIME_TICK_MS = 30_000

const FILTERS: readonly { key: ListFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "unread", label: "Unread" },
  { key: "mentions", label: "Mentions" },
]

type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; conversations: TeamsConversation[]; cursor: string | null }

const errorMessage = (e: unknown): string => {
  if (e instanceof TeamsApiError) {
    if (e.code === "invalid_auth") return "Teams sign-in needed. Open Teams on the remote browser."
    if (e.code === "rate_limited") return "Teams is rate-limiting. Try again in a moment."
  }
  return "Could not load conversations."
}

interface ConversationListProps {
  onOpenConversation: (conversation: TeamsConversation) => void
  /** The open conversation, highlighted in the wide two-pane; null on the phone (stacked). */
  selectedId?: string | null
  /** The keyboard-focused row (t152) — a coral ring, distinct from `selectedId`. */
  focusedId?: string | null
  /** Fires with the loaded list (and every merge), so a deep-linked stub pane can pick up its
   *  real metadata (title etc.) once the list arrives (t150). */
  onConversations?: (conversations: TeamsConversation[]) => void
  /** Optimistic read-state patches by conv id (t155): applied over the server rows HERE — the rows
   *  render from this component's own state, so this is the only patch point that reaches the
   *  screen — and echoed through `onConversations` so the app's copy agrees. A server poll can't
   *  clobber an override (read = readTs floor, unread = forced sticky). */
  readOverrides?: Record<string, ReadOverride>
  /** Local conversation prefs by id (t156): labels/folder/mute, applied over the rows HERE (same
   *  pattern as readOverrides) so a poll can't clobber them. Groups the list into folder sections. */
  prefs?: Record<string, ConvPrefs>
  /** Collapsed folder names (per-device view state, t156). */
  collapsedFolders?: Set<string>
  onToggleFolder?: (folder: string) => void
  /** Patch a conversation's prefs from the row menu (t156/t167/t168). */
  onPatchPrefs?: (convId: string, patch: ConvPrefsPatch) => void
  /** Folder display order for DnD-sortable sections (Workstream I). */
  folderOrder?: string[]
  /** Called when the user drops a folder header to a new position. */
  onReorderFolders?: (order: string[]) => void
  /** Name display preference (t161) — applied to 1:1 row labels. */
  namePref?: NamePref
  /** Background poll health (PSN-91): false when a refresh fails, true when it succeeds. Drives the
   *  app's "Reconnecting…" banner. */
  onConnectionChange?: (ok: boolean) => void
}

/** The conversation list — loads `POST /api/teams/conversations` (first page), covers all four
 *  states, and auto-pages older via infinite scroll (a bottom IntersectionObserver sentinel, t136)
 *  driven by the backwardLink cursor (t134). */
export function ConversationList({
  onOpenConversation,
  selectedId,
  focusedId,
  onConversations,
  readOverrides,
  prefs,
  collapsedFolders,
  onToggleFolder,
  onPatchPrefs,
  folderOrder,
  onReorderFolders,
  namePref,
  onConnectionChange,
}: ConversationListProps) {
  const [state, setState] = useState<State>({ status: "loading" })
  const [draggingId, setDraggingId] = useState<string | null>(null)
  // Older-page paging (t134): true while a "Load more" fetch is in flight (dedup guard + affordance).
  const [loadingMore, setLoadingMore] = useState(false)
  const loadingMoreRef = useRef(false)
  // Segmented list filter (t168): All / Unread / Mentions. View-state only, resets on reload.
  const [filter, setFilter] = useState<ListFilter>("all")
  // Live "ago" clock (t168): rows render times against this, so one tick refreshes them all.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) setNow(Date.now())
    }, TIME_TICK_MS)
    return () => clearInterval(timer)
  }, [])

  const load = useCallback((signal?: AbortSignal) => {
    setState({ status: "loading" })
    fetchConversations(undefined, signal)
      .then((page) => {
        if (!signal?.aborted)
          setState({ status: "ready", conversations: page.conversations, cursor: page.cursor })
      })
      .catch((e) => {
        if (signal?.aborted) return
        setState({ status: "error", message: errorMessage(e) })
      })
  }, [])

  useEffect(() => {
    const ac = new AbortController()
    load(ac.signal)
    return () => ac.abort()
  }, [load])

  // The rows render from THIS list with the optimistic read overrides applied (t155) — patching any
  // other copy of the conversations never reaches the screen. applyReadOverride returns the same
  // ref for a no-op, so the map is cheap and identity-stable when overrides don't bite.
  const conversations = state.status === "ready" ? state.conversations : null
  const display = useMemo(
    () =>
      conversations
        ? filterConversations(
            conversations.map((c) =>
              applyPrefs(applyReadOverride(c, readOverrides?.[c.id]), prefs?.[c.id]),
            ),
            filter,
          )
        : null,
    [conversations, readOverrides, prefs, filter],
  )

  // Group into folder sections (t156): folders alpha-sorted on top, ungrouped rows below. A flat
  // list (no folders assigned) collapses to one null section — the render treats that as the plain,
  // header-less list it was before. Filtering runs first (t168), so an empty folder drops out.
  const sections = useMemo(
    () => (display ? groupByFolder(display, folderOrder) : null),
    [display, folderOrder],
  )

  // Report the override-applied list upward whenever it (referentially) changes, so the app's copy
  // (keyboard toggle, ⌘K predicates) agrees with what's on screen.
  useEffect(() => {
    if (display) onConversations?.(display)
  }, [display, onConversations])

  // Re-union page 1 into the list without disturbing the paging cursor / Load-more state (t135).
  // No-ops unless "ready"; mergeConversations returns the same ref when nothing changed, so we skip
  // the setState (and its re-render) then. Errors are swallowed — a failed refresh keeps the list.
  const refresh = useCallback(() => {
    fetchConversations()
      .then((page) => {
        onConnectionChange?.(true)
        setState((s) => {
          if (s.status !== "ready") return s
          const merged = mergeConversations(s.conversations, page.conversations)
          return merged === s.conversations ? s : { ...s, conversations: merged }
        })
      })
      .catch(() => {
        // The last-good list stays put (t135); flag the connection so the app shows a banner.
        onConnectionChange?.(false)
      })
  }, [onConnectionChange])

  // Refresh on a cadence + on the tab returning to foreground / window focus. Paused while hidden.
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined
    const start = () => {
      if (timer == null) timer = setInterval(refresh, LIST_POLL_MS)
    }
    const stop = () => {
      if (timer != null) {
        clearInterval(timer)
        timer = undefined
      }
    }
    const onVisibility = () => {
      if (document.hidden) stop()
      else {
        refresh()
        start()
      }
    }
    const onFocus = () => refresh()
    if (!document.hidden) start()
    document.addEventListener("visibilitychange", onVisibility)
    window.addEventListener("focus", onFocus)
    return () => {
      stop()
      document.removeEventListener("visibilitychange", onVisibility)
      window.removeEventListener("focus", onFocus)
    }
  }, [refresh])

  const loadMore = useCallback(() => {
    if (loadingMoreRef.current) return
    if (state.status !== "ready" || !state.cursor) return
    loadingMoreRef.current = true
    setLoadingMore(true)
    fetchConversations(state.cursor)
      .then((page) => {
        setState((s) => {
          if (s.status !== "ready") return s
          const known = new Set(s.conversations.map((c) => c.id))
          const fresh = page.conversations.filter((c) => !known.has(c.id))
          return {
            status: "ready",
            conversations: [...s.conversations, ...fresh],
            cursor: page.cursor,
          }
        })
      })
      // Stop paging if a page fetch fails — the sentinel unmounts on a null cursor.
      .catch(() => setState((s) => (s.status === "ready" ? { ...s, cursor: null } : s)))
      .finally(() => {
        loadingMoreRef.current = false
        setLoadingMore(false)
      })
  }, [state])

  // Infinite scroll (t136): auto-load the next page when a bottom sentinel scrolls into view,
  // replacing the manual "Load more" button. A ref holds the latest loadMore so the observer is
  // built once per cursor-presence change (not per appended row); rootMargin prefetches ahead of
  // the true bottom so paging feels seamless. Observer root defaults to the viewport — the list
  // scroll container fills it, so the sentinel intersects as it nears the bottom.
  const sentinelRef = useRef<HTMLDivElement>(null)
  const loadMoreRef = useRef(loadMore)
  loadMoreRef.current = loadMore
  const hasMore = state.status === "ready" && state.cursor != null
  useEffect(() => {
    if (!hasMore) return
    const el = sentinelRef.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMoreRef.current()
      },
      { rootMargin: "400px 0px" },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [hasMore])

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))

  const realFolderIds = useMemo(
    () =>
      (sections ?? [])
        .filter((s) => s.folder && s.folder !== CHATS_FOLDER)
        .map((s) => `folder:${s.folder}`),
    [sections],
  )

  const handleDragStart = useCallback((e: DragStartEvent) => {
    setDraggingId(String(e.active.id))
  }, [])

  const handleDragEnd = useCallback(
    (e: DragEndEvent) => {
      setDraggingId(null)
      const { active, over } = e
      if (!over || active.id === over.id) return
      const activeId = String(active.id)
      const overId = String(over.id)
      // Two droppable namespaces resolve to one folder id: `folder:X` (the sortable header) and
      // `drop:X` (the whole section container, X = folder name or `__null__` for ungrouped).
      const overFolder = overId.startsWith("drop:")
        ? overId.slice(5)
        : overId.startsWith("folder:")
          ? overId.slice(7)
          : null
      if (overFolder == null) return

      // Folder-to-folder reorder.
      if (activeId.startsWith("folder:")) {
        const allRealFolders = (sections ?? [])
          .filter((s) => s.folder && s.folder !== CHATS_FOLDER)
          .map((s) => s.folder as string)
        const fromIdx = allRealFolders.indexOf(activeId.slice(7))
        const toIdx = allRealFolders.indexOf(overFolder)
        if (fromIdx !== -1 && toIdx !== -1 && fromIdx !== toIdx) {
          const next = arrayMove(allRealFolders, fromIdx, toIdx)
          onReorderFolders?.(next)
        }
        return
      }

      // Conv dragged onto a folder header/section → move it there; ungrouped clears the folder.
      if (activeId.startsWith("conv:")) {
        const convId = activeId.slice(5)
        const folder = overFolder === CHATS_FOLDER || overFolder === "__null__" ? null : overFolder
        onPatchPrefs?.(convId, { folder })
        return
      }
    },
    [sections, onPatchPrefs, onReorderFolders],
  )

  if (state.status === "loading") return <ListSkeleton />

  if (state.status === "error") {
    return (
      <EmptyState icon={Alert02Icon} title={state.message}>
        <Button onClick={() => load()} size="sm" variant="outline">
          <HugeiconsIcon icon={ReloadIcon} />
          Retry
        </Button>
      </EmptyState>
    )
  }

  if (state.conversations.length === 0) {
    return <EmptyState icon={InboxIcon} title="No conversations" />
  }

  const hasFolders = (sections ?? []).some((s) => s.folder && s.folder !== CHATS_FOLDER)

  const renderRow = (c: TeamsConversation) => {
    const row = (
      <ConversationRow
        active={c.id === selectedId}
        conversation={c}
        focused={c.id === focusedId}
        key={c.id}
        namePref={namePref}
        now={now}
        onOpen={onOpenConversation}
      />
    )
    // Wrap in the right-click / long-press prefs menu when the app injected a patch handler.
    const withMenu = !onPatchPrefs ? (
      row
    ) : (
      <ConversationRowMenu
        allPrefs={prefs ?? {}}
        convId={c.id}
        key={c.id}
        onPatch={onPatchPrefs}
        prefs={prefs?.[c.id] ?? { labels: [], folder: null, muted: false }}
      >
        {row}
      </ConversationRowMenu>
    )
    // Draggable-into-folder only when folders exist (useDraggable needs the DndContext mounted).
    if (!hasFolders || !onPatchPrefs) return withMenu
    return (
      <DraggableConvRow convId={c.id} key={c.id}>
        {withMenu}
      </DraggableConvRow>
    )
  }

  // Segmented filter bar (t168): always visible once rows exist, so a filtered-empty view can
  // switch back. j/k agrees automatically — the reported list IS the filtered list.
  const filterBar = (
    // pl-3 matches the row's px-3, so the first button's left edge lines up with the row avatars.
    <div className="flex gap-1 pr-1 pb-1.5 pl-3">
      {FILTERS.map((f) => (
        <button
          className={cn(
            "rounded-full px-2.5 py-1 font-medium text-xs transition-colors",
            filter === f.key
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
          key={f.key}
          onClick={() => setFilter(f.key)}
          type="button"
        >
          {f.label}
        </button>
      ))}
    </div>
  )

  if ((display?.length ?? 0) === 0) {
    return (
      <div className="flex flex-col p-2">
        {filterBar}
        <EmptyState
          icon={InboxIcon}
          title={filter === "unread" ? "Nothing unread" : "No unread mentions"}
        />
      </div>
    )
  }

  const sectionsList = (
    <>
      {(sections ?? []).map((section) => (
        <FolderGroup
          collapsed={!!section.folder && !!collapsedFolders?.has(section.folder)}
          dragging={draggingId}
          key={section.folder ?? "__ungrouped"}
          onPatchPrefs={onPatchPrefs}
          onToggle={onToggleFolder}
          section={section}
        >
          {section.conversations.map(renderRow)}
        </FolderGroup>
      ))}
    </>
  )

  return (
    <div className="flex flex-col gap-0.5 p-2">
      {filterBar}
      {hasFolders ? (
        <DndContext
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
          onDragStart={handleDragStart}
          sensors={sensors}
        >
          <SortableContext items={realFolderIds} strategy={verticalListSortingStrategy}>
            {sectionsList}
          </SortableContext>
          <DragOverlay>
            {draggingId ? (
              <div className="rounded-md bg-muted px-2 py-1.5 font-semibold text-muted-foreground text-xs shadow-md opacity-90">
                {draggingId.startsWith("folder:")
                  ? folderLabel(draggingId.slice(7))
                  : (display?.find((c) => c.id === draggingId.slice(5))?.title ?? "Conversation")}
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      ) : (
        sectionsList
      )}
      {hasMore && (
        // Keep the sentinel mounted (with a little idle height so the observer keeps firing); while
        // paging, fill it with ~3 row skeletons — a reserved-height placeholder the real rows swap
        // into, so the append doesn't collapse or blink the indicator.
        <div className="flex flex-col gap-0.5 py-1" ref={sentinelRef}>
          {loadingMore &&
            Array.from({ length: 3 }).map((_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows, no identity
              <ConversationRowSkeleton key={i} />
            ))}
        </div>
      )}
    </div>
  )
}

// Makes one conversation row draggable into/out of folder sections. Listeners live on a wrapper
// div (the row keeps its own click/context-menu handlers; the 8px activation distance separates a
// click from a drag). Only mounted when the DndContext is (folders exist).
function DraggableConvRow({ convId, children }: { convId: string; children: React.ReactNode }) {
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({ id: `conv:${convId}` })
  return (
    <div className={cn(isDragging && "opacity-40")} ref={setNodeRef} {...attributes} {...listeners}>
      {children}
    </div>
  )
}

// A folder section (t156): a named folder gets a collapsible header (chevron + name + count);
// the ungrouped (null) section renders its rows bare, so a list with no folders looks unchanged.
function FolderGroup({
  section,
  collapsed,
  onToggle,
  onPatchPrefs,
  dragging,
  children,
}: {
  section: FolderSection
  collapsed: boolean
  onToggle?: (folder: string) => void
  onPatchPrefs?: (convId: string, patch: ConvPrefsPatch) => void
  dragging?: string | null
  children: React.ReactNode
}) {
  const folderId = section.folder ?? "__null__"
  const isRealFolder = section.folder !== null && section.folder !== CHATS_FOLDER
  const sortable = useSortable({
    id: `folder:${folderId}`,
    disabled: !isRealFolder,
  })
  // Distinct id from the sortable's — duplicate droppable ids make dnd-kit's collision detection
  // pick one registration unpredictably (the original conv-drop bug).
  const { isOver, setNodeRef: setDropRef } = useDroppable({ id: `drop:${folderId}` })

  const isDraggingConv = dragging?.startsWith("conv:")

  // Ungrouped section: no header, but still a drop target so a conv can be dragged OUT of a folder.
  if (section.folder == null)
    return (
      <div
        className={cn(
          "flex flex-col gap-0.5",
          isDraggingConv && isOver && "rounded-md bg-muted/60 ring-1 ring-primary/30",
        )}
        ref={setDropRef}
      >
        {children}
      </div>
    )

  const headerStyle = isRealFolder
    ? { transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition }
    : {}

  return (
    <div
      className="flex flex-col gap-0.5"
      ref={
        isRealFolder
          ? (node) => {
              sortable.setNodeRef(node)
              setDropRef(node)
            }
          : setDropRef
      }
    >
      <button
        aria-expanded={!collapsed}
        className={cn(
          "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-muted-foreground text-xs transition-colors hover:bg-muted hover:text-foreground",
          isDraggingConv && isOver && "bg-muted/60 ring-1 ring-primary/30",
          sortable.isDragging && "opacity-40",
        )}
        onClick={() => onToggle?.(section.folder as string)}
        ref={isRealFolder ? sortable.setActivatorNodeRef : undefined}
        style={headerStyle}
        type="button"
        {...(isRealFolder ? sortable.attributes : {})}
        {...(isRealFolder ? sortable.listeners : {})}
      >
        <HugeiconsIcon
          className={cn("size-3.5 transition-transform", !collapsed && "rotate-90")}
          icon={ArrowRight01Icon}
        />
        <span className="truncate font-semibold uppercase tracking-wide">
          {folderLabel(section.folder as string)}
        </span>
        <span className="ml-auto font-mono text-[10px]">{section.conversations.length}</span>
      </button>
      {!collapsed && <div className="flex flex-col gap-0.5">{children}</div>}
    </div>
  )
}

// One placeholder row matching ConversationRow's height + layout (size-10 avatar + two lines). Shared
// by the full-screen initial skeleton and the infinite-scroll load-more placeholder so they can't drift.
function ConversationRowSkeleton() {
  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <div className="size-10 shrink-0 animate-pulse rounded-full bg-muted" />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="h-3.5 w-2/5 animate-pulse rounded bg-muted" />
        <div className="h-3 w-3/4 animate-pulse rounded bg-muted" />
      </div>
    </div>
  )
}

function ListSkeleton() {
  return (
    <div aria-hidden className="flex flex-col gap-0.5 p-2">
      {Array.from({ length: 7 }).map((_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows, no identity
        <ConversationRowSkeleton key={i} />
      ))}
    </div>
  )
}

function EmptyState({
  icon,
  title,
  children,
}: {
  icon: typeof InboxIcon
  title: string
  children?: React.ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <HugeiconsIcon className="size-8 text-muted-foreground" icon={icon} />
      <p className="max-w-xs text-sm text-muted-foreground">{title}</p>
      {children}
    </div>
  )
}
