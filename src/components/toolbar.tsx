import { ArrowLeft01Icon, ArrowRight01Icon, PinIcon, ReloadIcon } from "@hugeicons/core-free-icons"
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
  onClearNotifications: () => void
  notificationsEnabled: boolean
  onNotificationsEnabledChange: (enabled: boolean) => void
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
    onClearNotifications,
    notificationsEnabled,
    onNotificationsEnabledChange,
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
        "flex items-center gap-1.5 h-11 px-3 bg-card border-b border-border",
        sidebarCollapsed && "pl-20",
      )}
      style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
    >
      {/* Nav buttons */}
      <div
        className="flex items-center gap-0.5"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
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
          <TooltipContent>Back</TooltipContent>
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
          <TooltipContent>Forward</TooltipContent>
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
          <TooltipContent>Reload</TooltipContent>
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
        className="flex items-center gap-1 text-[10px] text-muted-foreground select-none shrink-0"
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
          <TooltipContent>{status}</TooltipContent>
        </Tooltip>

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
          <TooltipContent>{isPinned ? "Unpin this tab" : "Pin this tab"}</TooltipContent>
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
                <TooltipContent>{ext.name}</TooltipContent>
              </Tooltip>
            ))}

        {/* Notifications */}
        <NotificationBell
          notifications={notifications}
          onClearAll={onClearNotifications}
          onClickItem={onNotificationClick}
          onMarkAllRead={onMarkAllRead}
          onOpenChange={onBellOpenChange}
          onToggleRead={onNotificationToggleRead}
          open={bellOpen}
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
          open={settingsOpen}
          switchEffect={switchEffect}
          syncTheme={syncTheme}
          theme={theme}
        />
      </div>
    </div>
  )
})
