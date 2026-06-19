import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  CommandIcon,
  InboxIcon,
  PinIcon,
  ReloadIcon,
  Search01Icon,
  SidebarLeft01Icon,
  SidebarLeftIcon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react"
import { type NotifEntry, NotificationBell } from "@/components/notification-bell"
import { SettingsDialog, type SwitchEffect } from "@/components/settings-dialog"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

interface ToolbarProps {
  url: string
  sidebarCollapsed: boolean
  onToggleSidebar: () => void
  /** Phone Shell (t076): replaces the sidebar toggle with a back-to-Inbox button. */
  onBackToInbox?: () => void
  onNavigate: (url: string) => void
  onBack: () => void
  onForward: () => void
  onReload: () => void
  canGoBack: boolean
  canGoForward: boolean
  pageLoading: boolean
  status: string
  fps: string
  theme: "system" | "light" | "dark"
  onThemeChange: (theme: "system" | "light" | "dark") => void
  isPinned: boolean
  onTogglePin: () => void
  onOpenFind: () => void
  /** Touch launcher for the ⌘K command palette — iPad has no Cmd+K without a keyboard. */
  onOpenCommandPalette: () => void
  settingsOpen: boolean
  settingsCommitted: boolean
  onSettingsOpenChange: (open: boolean) => void
  onSettingsRequestOpenMouse: () => void
  onSettingsCommit: () => void
  onConfigSaved?: () => void
  adaptiveViewport: boolean
  onAdaptiveViewportChange: (enabled: boolean) => void
  forceOnClient: boolean
  onForceOnClientChange: (enabled: boolean) => void
  emulatedSize: { w: number; h: number } | null
  switchEffect: SwitchEffect
  onSwitchEffectChange: (effect: SwitchEffect) => void
  notifications: NotifEntry[]
  bellOpen: boolean
  onBellOpenChange: (open: boolean) => void
  onNotificationClick: (entry: NotifEntry) => void
  onNotificationToggleRead: (entry: NotifEntry) => void
  onMarkAllRead: () => void
  onMarkThreadRead: (entry: NotifEntry) => void
  onClearThread: (entry: NotifEntry) => void
  onMuteChannel: (entry: NotifEntry) => void
  onClearNotifications: () => void
  notificationsEnabled: boolean
  onNotificationsEnabledChange: (enabled: boolean) => void
  /** Device-aware unread badge for the bell — excludes this device's muted sources +
   *  goes to 0 when the master is off (t093, web). Undefined on Electron (own count). */
  notificationUnreadBadge?: number
  /** This device's muted sources (muteKeys), and the toggle to mute/un-mute one (t093,
   *  web only — the per-device "Notifications (this device)" settings card drives them). */
  notifMutes: string[]
  onToggleMute: (key: string) => void
  syncTheme: boolean
  onSyncThemeChange: (enabled: boolean) => void
  autoGrantLocalMedia: boolean
  onAutoGrantLocalMediaChange: (enabled: boolean) => void
  /** Extensions apply to local tabs only — their toolbar icons hide for CDP tabs. */
  isLocalActive: boolean
  localExtensions: LocalExtensionInfo[]
  onAddLocalExtension: () => void
  onReloadLocalExtension: (path: string) => void
  onRemoveLocalExtension: (path: string) => void
  onOpenExtensionUrl: (url: string) => void
  onOpenActionPopup: (id: string, anchor: { right: number; bottom: number }) => void
}

export interface ToolbarHandle {
  focusUrlBar: () => void
}

export const Toolbar = forwardRef<ToolbarHandle, ToolbarProps>(function Toolbar(
  {
    url,
    sidebarCollapsed,
    onToggleSidebar,
    onBackToInbox,
    onNavigate,
    onBack,
    onForward,
    onReload,
    canGoBack,
    canGoForward,
    pageLoading,
    status,
    fps,
    theme,
    onThemeChange,
    isPinned,
    onTogglePin,
    onOpenFind,
    onOpenCommandPalette,
    settingsOpen,
    settingsCommitted,
    onSettingsOpenChange,
    onSettingsRequestOpenMouse,
    onSettingsCommit,
    onConfigSaved,
    adaptiveViewport,
    onAdaptiveViewportChange,
    forceOnClient,
    onForceOnClientChange,
    emulatedSize,
    switchEffect,
    onSwitchEffectChange,
    notifications,
    bellOpen,
    onBellOpenChange,
    onNotificationClick,
    onNotificationToggleRead,
    onMarkAllRead,
    onMarkThreadRead,
    onClearThread,
    onMuteChannel,
    onClearNotifications,
    notificationsEnabled,
    onNotificationsEnabledChange,
    notificationUnreadBadge,
    notifMutes,
    onToggleMute,
    syncTheme,
    onSyncThemeChange,
    autoGrantLocalMedia,
    onAutoGrantLocalMediaChange,
    isLocalActive,
    localExtensions,
    onAddLocalExtension,
    onReloadLocalExtension,
    onRemoveLocalExtension,
    onOpenExtensionUrl,
    onOpenActionPopup,
  },
  ref,
) {
  const isConnected = status === "Connected"
  const isError = status.startsWith("Error")

  const [draft, setDraft] = useState(url)
  const [focused, setFocused] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useImperativeHandle(ref, () => ({
    focusUrlBar: () => {
      inputRef.current?.focus()
      inputRef.current?.select()
    },
  }))

  // Sync external URL into draft only when not focused
  useEffect(() => {
    if (!focused) {
      setDraft(url)
    }
  }, [url, focused])

  const handleSubmit = () => {
    onNavigate(draft)
    inputRef.current?.blur()
  }

  const handleBlur = () => {
    setFocused(false)
    setDraft(url) // restore to actual URL
  }

  return (
    <div
      className={cn(
        // Top safe-area inset is reserved at the app root (app.tsx). Fixed h-11 (not
        // min-h-11) so the bar is exactly 44px and its bottom border lines up with the
        // sidebar header's — a coarse-pointer 44px button + border-b would otherwise push
        // a min-h-11 bar to 45px while the empty header stays 44.
        "flex items-center gap-1.5 h-11 px-3 bg-card border-b border-border",
        // Phone Shell (onBackToInbox present) has no sidebar to absorb the LEFT safe-area
        // inset, so the toolbar is the leftmost element — in landscape its back/forward
        // buttons would fall under the notch. Wide layout keeps the sidebar's inset (unchanged).
        onBackToInbox && "pl-[max(0.75rem,env(safe-area-inset-left))]",
      )}
      style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
    >
      {/* Nav buttons */}
      <div
        className="flex items-center gap-0.5"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        {/* Sidebar collapse toggle — lives in the toolbar (not the sidebar) so it keeps a
            fixed position regardless of collapsed state. Icon flips to hint direction.
            Phone Shell has no sidebar — the slot becomes the back-to-Inbox button. */}
        {onBackToInbox ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                aria-label="Back to Inbox"
                className="text-muted-foreground hover:text-foreground"
                onClick={onBackToInbox}
                size="icon-xs"
                variant="ghost"
              >
                <HugeiconsIcon className="size-3.5" icon={InboxIcon} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Back to Inbox</TooltipContent>
          </Tooltip>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                className="text-muted-foreground hover:text-foreground"
                onClick={onToggleSidebar}
                size="icon-xs"
                variant="ghost"
              >
                <HugeiconsIcon
                  className="size-3.5"
                  icon={sidebarCollapsed ? SidebarLeftIcon : SidebarLeft01Icon}
                />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            </TooltipContent>
          </Tooltip>
        )}

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              className="text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:pointer-events-none"
              disabled={!canGoBack}
              onClick={onBack}
              size="icon-xs"
              variant="ghost"
            >
              <HugeiconsIcon className="size-3.5" icon={ArrowLeft01Icon} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Back</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              className="text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:pointer-events-none"
              disabled={!canGoForward}
              onClick={onForward}
              size="icon-xs"
              variant="ghost"
            >
              <HugeiconsIcon className="size-3.5" icon={ArrowRight01Icon} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Forward</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              className="text-muted-foreground hover:text-foreground"
              onClick={onReload}
              size="icon-xs"
              variant="ghost"
            >
              <HugeiconsIcon className="size-3" icon={ReloadIcon} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Reload</TooltipContent>
        </Tooltip>
      </div>

      {/* URL bar */}
      <div
        className="flex-1 mx-2 relative"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        <input
          className="w-full h-7 px-3 text-xs bg-background border border-border rounded-full text-foreground placeholder:text-muted-foreground outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/25 transition-all"
          onBlur={handleBlur}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={() => setFocused(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSubmit()
            if (e.key === "Escape") inputRef.current?.blur()
          }}
          placeholder="Search or enter URL..."
          ref={inputRef}
          type="text"
          value={draft}
        />
        {pageLoading && (
          <div className="absolute bottom-0 left-3 right-3 h-0.5 rounded-full overflow-hidden">
            <div className="h-full bg-primary/60 rounded-full animate-loading-bar" />
          </div>
        )}
      </div>

      {/* Right side actions */}
      <div
        className="flex items-center gap-1 pr-[max(0px,env(safe-area-inset-right))] text-[10px] text-muted-foreground select-none shrink-0"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        {fps && <span className="mr-1 inline-block w-[48px] text-right tabular-nums">{fps}</span>}

        <Tooltip>
          <TooltipTrigger asChild>
            <span className="flex items-center cursor-default">
              <span
                className={cn(
                  "size-2 rounded-full bg-current",
                  isConnected ? "text-emerald-500" : isError ? "text-red-500" : "text-yellow-500",
                )}
              />
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">{status}</TooltipContent>
        </Tooltip>

        {/* Command palette + find — keyboard-centric surfaces, cut from the Phone Shell
            (t081): their launchers hide when the back-to-Inbox slot is active. */}
        {!onBackToInbox && (
          <>
            {/* Command palette — touch launcher (iPad has no ⌘K without a keyboard). Radix
                Slot merges the child Button's data-slot/data-size through `asChild`, so the
                coarse 44pt bump (keyed on data-slot="button") reaches it directly — same as
                the find/pin/bell/settings siblings, no extra opt-in needed. */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label="Open command palette"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={onOpenCommandPalette}
                  size="icon-xs"
                  variant="ghost"
                >
                  <HugeiconsIcon className="size-3.5" icon={CommandIcon} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Command palette (⌘K)</TooltipContent>
            </Tooltip>

            {/* Find in page */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label="Find in page"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={onOpenFind}
                  size="icon-xs"
                  variant="ghost"
                >
                  <HugeiconsIcon className="size-3.5" icon={Search01Icon} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Find in page</TooltipContent>
            </Tooltip>
          </>
        )}

        {/* Pin */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              className={cn(
                "hover:text-foreground",
                isPinned ? "text-primary" : "text-muted-foreground",
              )}
              onClick={onTogglePin}
              size="icon-xs"
              variant="ghost"
            >
              <HugeiconsIcon
                className="size-3.5"
                fill={isPinned ? "currentColor" : "none"}
                icon={PinIcon}
              />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {isPinned ? "Unpin this tab" : "Pin this tab"}
          </TooltipContent>
        </Tooltip>

        {/* Loaded extension action icons — local tabs only (Electron has no
            native browser-action bar). */}
        {isLocalActive &&
          localExtensions
            .filter((ext) => ext.loaded && ext.popupUrl && ext.icon)
            .map((ext) => (
              <Tooltip key={ext.path}>
                <TooltipTrigger asChild>
                  <Button
                    className="text-muted-foreground hover:text-foreground"
                    onClick={(e) => {
                      const r = e.currentTarget.getBoundingClientRect()
                      onOpenActionPopup(ext.id as string, { right: r.right, bottom: r.bottom })
                    }}
                    size="icon-xs"
                    variant="ghost"
                  >
                    <img alt="" className="size-4 rounded-sm" src={ext.icon as string} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{ext.name}</TooltipContent>
              </Tooltip>
            ))}

        {/* Notifications */}
        <NotificationBell
          mutes={notifMutes}
          notifications={notifications}
          onClearAll={onClearNotifications}
          onClearThread={onClearThread}
          onClickItem={onNotificationClick}
          onMarkAllRead={onMarkAllRead}
          onMarkThreadRead={onMarkThreadRead}
          onMuteChannel={onMuteChannel}
          onOpenChange={onBellOpenChange}
          onToggleRead={onNotificationToggleRead}
          open={bellOpen}
          unreadBadge={notificationUnreadBadge}
        />

        {/* Settings */}
        <SettingsDialog
          adaptiveViewport={adaptiveViewport}
          autoGrantLocalMedia={autoGrantLocalMedia}
          committed={settingsCommitted}
          emulatedSize={emulatedSize}
          forceOnClient={forceOnClient}
          localExtensions={localExtensions}
          notificationsEnabled={notificationsEnabled}
          notifMutes={notifMutes}
          onAdaptiveViewportChange={onAdaptiveViewportChange}
          onAddLocalExtension={onAddLocalExtension}
          onAutoGrantLocalMediaChange={onAutoGrantLocalMediaChange}
          onCommit={onSettingsCommit}
          onConfigSaved={onConfigSaved}
          onForceOnClientChange={onForceOnClientChange}
          onNotificationsEnabledChange={onNotificationsEnabledChange}
          onOpenChange={onSettingsOpenChange}
          onOpenExtensionUrl={onOpenExtensionUrl}
          onReloadLocalExtension={onReloadLocalExtension}
          onRemoveLocalExtension={onRemoveLocalExtension}
          onRequestOpenMouse={onSettingsRequestOpenMouse}
          onSwitchEffectChange={onSwitchEffectChange}
          onSyncThemeChange={onSyncThemeChange}
          onThemeChange={onThemeChange}
          onToggleMute={onToggleMute}
          open={settingsOpen}
          switchEffect={switchEffect}
          syncTheme={syncTheme}
          theme={theme}
        />
      </div>
    </div>
  )
})
