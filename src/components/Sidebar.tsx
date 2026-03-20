import { useState } from "react";
import {
  X,
  Plus,
  PanelLeftClose,
  PanelLeft,
  Globe,
  ChevronDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { TabInfo } from "@/App";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { restrictToVerticalAxis, restrictToParentElement } from "@dnd-kit/modifiers";

interface SidebarProps {
  tabs: TabInfo[];
  activeTabId: string | null;
  onSwitchTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onNewTab: () => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  bookmarks: Bookmark[];
  onNavigateBookmark: (url: string) => void;
  onOpenBookmarkInNewTab: (url: string) => void;
  onRemoveBookmark: (url: string) => void;
  onReorderBookmarks: (bookmarks: Bookmark[]) => void;
  onReorderTabs: (tabs: TabInfo[]) => void;
}

export function Sidebar({
  tabs,
  activeTabId,
  onSwitchTab,
  onCloseTab,
  onNewTab,
  collapsed,
  onToggleCollapse,
  bookmarks,
  onNavigateBookmark,
  onOpenBookmarkInNewTab,
  onRemoveBookmark,
  onReorderBookmarks,
  onReorderTabs,
}: SidebarProps) {
  const [pinnedOpen, setPinnedOpen] = useState(true);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 3 } })
  );

  const handleBookmarkDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const oldIndex = bookmarks.findIndex((b) => b.id === active.id);
      const newIndex = bookmarks.findIndex((b) => b.id === over.id);
      onReorderBookmarks(arrayMove(bookmarks, oldIndex, newIndex));
    }
  };

  const handleTabDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const oldIndex = tabs.findIndex((t) => t.id === active.id);
      const newIndex = tabs.findIndex((t) => t.id === over.id);
      onReorderTabs(arrayMove(tabs, oldIndex, newIndex));
    }
  };

  return (
    <div
      className={cn(
        "relative flex flex-col bg-sidebar border-r border-sidebar-border transition-all duration-200 shrink-0",
        collapsed ? "w-[52px]" : "w-[220px]"
      )}
    >
      {/* Drag region (traffic lights area) */}
      <div
        className="h-11 shrink-0 relative"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      >
        {/* Collapse button: beside traffic lights when expanded, below them when collapsed */}
        {!collapsed && (
          <div
            className="absolute top-2.5 right-2 z-10"
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={onToggleCollapse}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <PanelLeftClose className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">Collapse sidebar</TooltipContent>
            </Tooltip>
          </div>
        )}
      </div>

      {/* Collapse button below traffic lights when collapsed */}
      {collapsed && (
        <div className="flex justify-center pb-1 shrink-0">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={onToggleCollapse}
                className="text-muted-foreground hover:text-foreground"
              >
                <PanelLeft className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">Expand sidebar</TooltipContent>
          </Tooltip>
        </div>
      )}

      {/* Pinned section */}
      {bookmarks.length > 0 && (
        <div className="shrink-0">
          {!collapsed && (
            <button
              onClick={() => setPinnedOpen(!pinnedOpen)}
              className="flex items-center justify-between px-3 pb-1 w-full"
            >
              <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground select-none">
                Pinned
              </span>
              <ChevronDown
                className={cn(
                  "size-3 text-muted-foreground transition-transform duration-200",
                  !pinnedOpen && "-rotate-90"
                )}
              />
            </button>
          )}
          {(pinnedOpen || collapsed) && (
            <div className="px-2 pb-1">
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                modifiers={[restrictToVerticalAxis, restrictToParentElement]}
                onDragEnd={handleBookmarkDragEnd}
              >
                <SortableContext
                  items={bookmarks.map((b) => b.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="space-y-0.5">
                    {bookmarks.map((b) => (
                      <SortableBookmarkItem
                        key={b.id}
                        bookmark={b}
                        collapsed={collapsed}
                        onNavigate={() => onNavigateBookmark(b.url)}
                        onMiddleClick={() => onOpenBookmarkInNewTab(b.url)}
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
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis, restrictToParentElement]}
          onDragEnd={handleTabDragEnd}
        >
          <SortableContext
            items={tabs.map((t) => t.id)}
            strategy={verticalListSortingStrategy}
          >
            <div className="space-y-0.5 px-2 py-1">
              {tabs.map((tab) => (
                <SortableTabItem
                  key={tab.id}
                  tab={tab}
                  active={tab.id === activeTabId}
                  collapsed={collapsed}
                  onSwitch={() => onSwitchTab(tab.id)}
                  onClose={() => onCloseTab(tab.id)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      </div>

      {/* New tab button */}
      <div className="p-2 border-t border-sidebar-border shrink-0">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size={collapsed ? "icon-xs" : "sm"}
              onClick={onNewTab}
              className={cn(
                "text-muted-foreground hover:text-foreground",
                !collapsed && "w-full justify-start gap-2"
              )}
            >
              <Plus className="size-3.5" />
              {!collapsed && <span className="text-xs">New Tab</span>}
            </Button>
          </TooltipTrigger>
          {collapsed && (
            <TooltipContent side="right">New Tab</TooltipContent>
          )}
        </Tooltip>
      </div>
    </div>
  );
}

// --- Sortable Bookmark Item ---

function SortableBookmarkItem({
  bookmark,
  collapsed,
  onNavigate,
  onMiddleClick,
  onRemove,
}: {
  bookmark: Bookmark;
  collapsed: boolean;
  onNavigate: () => void;
  onMiddleClick: () => void;
  onRemove: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: bookmark.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 50 : undefined,
    opacity: isDragging ? 0.8 : undefined,
  };

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            ref={setNodeRef}
            style={style}
            {...attributes}
            {...listeners}
            className={cn(
              "flex items-center justify-center p-2 rounded-lg cursor-pointer text-sidebar-foreground hover:bg-accent/50 hover:text-foreground transition-colors",
              isDragging && "bg-accent/50"
            )}
            onClick={onNavigate}
            onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onMiddleClick(); } }}
          >
            <BookmarkFavicon favicon={bookmark.favicon} />
          </div>
        </TooltipTrigger>
        <TooltipContent side="right" className="max-w-[200px]">
          <p className="truncate">{bookmark.title}</p>
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Tooltip delayDuration={600}>
      <TooltipTrigger asChild>
        <div
          ref={setNodeRef}
          style={style}
          {...attributes}
          {...listeners}
          className={cn(
            "group relative flex items-center gap-2 px-2.5 py-1.5 rounded-lg cursor-pointer text-sidebar-foreground hover:bg-accent/50 hover:text-foreground transition-colors",
            isDragging && "bg-accent/50"
          )}
          onClick={onNavigate}
          onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onMiddleClick(); } }}
        >
          <BookmarkFavicon favicon={bookmark.favicon} />
          <span className="flex-1 text-xs truncate min-w-0">
            {bookmark.title}
          </span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            className="hidden group-hover:flex absolute right-2 text-muted-foreground hover:text-foreground"
          >
            <X className="size-3" />
          </button>
        </div>
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-[250px]">
        <p className="text-xs font-medium">{bookmark.title}</p>
        <p className="text-[10px] text-muted-foreground truncate">
          {bookmark.url}
        </p>
      </TooltipContent>
    </Tooltip>
  );
}

// --- Sortable Tab Item ---

function SortableTabItem({
  tab,
  active,
  collapsed,
  onSwitch,
  onClose,
}: {
  tab: TabInfo;
  active: boolean;
  collapsed: boolean;
  onSwitch: () => void;
  onClose: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: tab.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 50 : undefined,
    opacity: isDragging ? 0.8 : undefined,
  };

  const displayTitle = tab.title || "New Tab";

  return (
    <Tooltip delayDuration={600}>
      <TooltipTrigger asChild>
        <div
          ref={setNodeRef}
          style={style}
          {...attributes}
          {...listeners}
          className={cn(
            "group relative flex items-center gap-2 rounded-lg cursor-pointer transition-colors",
            collapsed ? "justify-center p-2" : "px-2.5 py-1.5",
            isDragging
              ? "bg-accent/50"
              : active
                ? "bg-sidebar-accent text-foreground shadow-sm"
                : "text-sidebar-foreground hover:bg-accent/50 hover:text-foreground"
          )}
          onClick={onSwitch}
          onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onClose(); } }}
        >
          {tab.faviconUrl ? (
            <img
              src={tab.faviconUrl}
              className="size-4 rounded-sm shrink-0"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = "none";
              }}
            />
          ) : (
            <div className="size-4 rounded-sm bg-muted shrink-0" />
          )}
          {!collapsed && (
            <>
              <span className="flex-1 text-xs truncate min-w-0">
                {displayTitle}
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onClose();
                }}
                className="hidden group-hover:flex absolute right-2 text-muted-foreground hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            </>
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent
        side={collapsed ? "right" : "bottom"}
        className="max-w-[300px]"
      >
        <p className="text-xs">{displayTitle}</p>
      </TooltipContent>
    </Tooltip>
  );
}

function BookmarkFavicon({ favicon }: { favicon?: string }) {
  if (favicon) {
    return (
      <img
        src={favicon}
        className="size-4 rounded-sm shrink-0"
        onError={(e) => {
          (e.target as HTMLImageElement).style.display = "none";
        }}
      />
    );
  }
  return <Globe className="size-4 shrink-0 text-muted-foreground" />;
}
