import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { CommandPalette } from "@/components/command-palette"
import { EditPinDialog } from "@/components/edit-pin-dialog"
import { FindBar, type FindBarHandle } from "@/components/find-bar"
import { LatencyHud } from "@/components/latency-hud"
import { type LocalApi, LocalWebviews } from "@/components/local-webviews"
import { NewTabDialog, type NewTabKind } from "@/components/new-tab-dialog"
import type { NotifEntry } from "@/components/notification-bell"
import type { SwitchEffect } from "@/components/settings-dialog"
import { ShortcutOverlay } from "@/components/shortcut-overlay"
import { Sidebar } from "@/components/sidebar"
import { StatusBar } from "@/components/status-bar"
import { Toolbar, type ToolbarHandle } from "@/components/toolbar"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Viewport } from "@/components/viewport"
import { type ActiveKind, useLocalTabs } from "@/hooks/use-local-tabs"
import { useRemotePage } from "@/hooks/use-remote-page"
import { type ActiveRef, dropActive } from "@/lib/active-order"
import { getCaps } from "@/lib/caps"
import { createClosedStack } from "@/lib/closed-tabs"
import { type Action, buildActions } from "@/lib/hotkey-registry"
import type { LocalTab } from "@/lib/local-tabs"
import {
  createActivationRegistry,
  deriveLegacyActivate,
  resolveActivation,
} from "@/lib/notification-activation"
import { threadKey } from "@/lib/notifications-view"
import { dropDeadLinks, pinForTarget, resolvePinLink } from "@/lib/pins"
import { startUpdateWatcher } from "@/lib/sw-update"
import { planClose, planSwitch } from "@/lib/tab-lifecycle"
import { reconcile, stripTitleBadge, type Tab } from "@/lib/tabs"
import { isTypingSurface } from "@/lib/typing-surface"
import { aggregateUnread } from "@/lib/unread-aggregator"
import { cn } from "@/lib/utils"
import {
  dispatchVirtualPointerMode,
  nextVirtualPointerMode,
  parseMode,
  VIRTUAL_POINTER_MODE_KEY,
} from "@/lib/virtual-pointer"

// Notification activation: each adapter plugs a deep-open variant in here; the click
// handler dispatches by `activate.type` with no per-adapter branching. Adding a third
// adapter is one new registry entry, not an edit to the click path.
const activationRegistry = createActivationRegistry()

export interface TabInfo {
  id: string
  title: string
  url: string
  faviconUrl?: string
  type: string
}

type ThemeSource = "system" | "light" | "dark"

// A keyboard-navigable row in the sidebar — a pin or a visible tab.
type NavRow =
  | { kind: "pin"; pin: Pin }
  | { kind: "tab"; id: string }
  | { kind: "local"; id: string }

function applyThemeClass(theme: ThemeSource, systemDark: boolean) {
  const isDark = theme === "dark" || (theme === "system" && systemDark)
  document.documentElement.classList.toggle("dark", isDark)
  syncThemeColorMeta()
}

// Normalize any CSS color to a concrete `rgb(...)` by painting it on a 1×1 canvas and
// reading the pixel back. Needed because `getComputedStyle` returns the authored
// `oklch(...)` (our theme vars) verbatim, which iOS Safari won't honor in `theme-color`.
function toRgb(color: string): string {
  const ctx = document.createElement("canvas").getContext("2d")
  if (!ctx) return color
  ctx.fillStyle = color
  ctx.fillRect(0, 0, 1, 1)
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
  return `rgb(${r}, ${g}, ${b})`
}

// Match the OS-painted PWA chrome (status bar / home-indicator safe area) to the live
// app background so it isn't a hardcoded near-black strip in light mode (t064). The
// manifest theme_color is baked at install and can't change live; this meta swap does.
// Read the resolved `--background` after the `.dark` toggle so it tracks whatever the
// CSS defines for each theme — no second source of truth for the colors.
function syncThemeColorMeta() {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  if (!meta) return
  const bg = getComputedStyle(document.body).backgroundColor
  if (bg) meta.content = toRgb(bg)
}

export default function App() {
  const [tabs, setTabs] = useState<TabInfo[]>([])
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const [url, setUrl] = useState("")
  const [status, setStatus] = useState("Disconnected")
  const [fps, setFps] = useState("")
  // resolution is consumed by Viewport but not displayed locally
  const [, setResolution] = useState("")
  const [loading, setLoading] = useState(true)
  const [loadingText, setLoadingText] = useState("Connecting...")
  const [pageLoading, setPageLoading] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [pinnedOpen, setPinnedOpen] = useState(true)
  const [adaptiveViewport, setAdaptiveViewport] = useState(false)
  const [forceOnClient, setForceOnClient] = useState(false)
  const [switchEffect, setSwitchEffect] = useState<SwitchEffect>("blur")
  const [emulatedSize, setEmulatedSize] = useState<{ w: number; h: number } | null>(null)
  // Bumped on every successful (re)connect so the Viewport re-applies the adaptive
  // override on a fresh socket — a tab switch doesn't change the container size, so
  // the ResizeObserver alone wouldn't re-trigger it.
  const [connectEpoch, setConnectEpoch] = useState(0)
  // Bumped the instant a tab switch starts (before the connect round-trip) so the
  // Viewport can begin its freeze/blur immediately rather than after the connection.
  const [switchSignal, setSwitchSignal] = useState(0)
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    typeof window !== "undefined" && window.innerWidth <= 1100 ? 180 : 220,
  )
  const uiStateLoadedRef = useRef(false)
  const [theme, setTheme] = useState<ThemeSource>("system")
  const [pins, setPins] = useState<Pin[]>([])
  const [notifications, setNotifications] = useState<NotifEntry[]>([])
  const [notificationsEnabled, setNotificationsEnabled] = useState(true)
  const [syncTheme, setSyncTheme] = useState(true)
  const [bellOpen, setBellOpen] = useState(false)
  const [newTabOpen, setNewTabOpen] = useState(false)
  const [newTabKind, setNewTabKind] = useState<NewTabKind>("cdp")
  // Slack-style: holding Cmd for 1s shows the jump number on each favicon.
  const [cmdHeld, setCmdHeld] = useState(false)
  const [editingPin, setEditingPin] = useState<Pin | null>(null)
  const [editingLocalId, setEditingLocalId] = useState<string | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // True when the drawer was opened via keyboard (Cmd+,) or promoted by a keypress —
  // a committed drawer ignores the mouse-leave auto-close timer.
  const [settingsCommitted, setSettingsCommitted] = useState(false)
  const settingsOpenRef = useRef(false)
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const tabOrderRef = useRef<string[]>([])
  const systemDarkRef = useRef(true)
  const toolbarRef = useRef<ToolbarHandle>(null)
  const findBarRef = useRef<FindBarHandle>(null)
  const closedTabsRef = useRef(createClosedStack())
  // Most-recently-used activation order across both kinds — on close, fall back
  // to the previous active tab rather than the next in the list.
  const activeOrderRef = useRef<ActiveRef[]>([])
  const tabsRef = useRef<TabInfo[]>([])
  const notificationsRef = useRef<NotifEntry[]>([])
  const activeTabIdRef = useRef<string | null>(null)
  const pinsRef = useRef<Pin[]>([])
  const page = useRemotePage()
  const caps = getCaps()

  const [autoGrantLocalMedia, setAutoGrantLocalMedia] = useState(true)
  const [localExtensions, setLocalExtensions] = useState<LocalExtensionInfo[]>([])
  const restoreLocalPinsRef = useRef(true)
  const localRestoredRef = useRef(false)

  // Local-tab refs live here (same scope as the other refs) so app.tsx's callbacks
  // see them as stable; the hook keeps them synced. On web they hold their empty
  // defaults because the hook is gated and never writes them.
  const localTabsRef = useRef<LocalTab[]>([])
  const localActiveIdRef = useRef<string | null>(null)
  const activeKindRef = useRef<ActiveKind>("cdp")
  // Imperative nav controls for the active local <webview>, set by LocalWebviews.
  const localApiRef = useRef<LocalApi | null>(null)
  // Late-bound so the one-time onOpenUrl listener always calls the latest impl.
  const createLocalTabRef = useRef<((url?: string) => Promise<string>) | null>(null)
  // switchTab is defined below the hook (it routes to setActiveKindCdp); late-bind
  // it through a ref so the hook's close/switch fallback can reach the CDP surface.
  const switchTabRef = useRef<((id: string) => void) | null>(null)

  // Local tabs — the structural gate. On web (caps.localTabs false) the hook returns
  // an empty list + no-op handlers, so no local-tab code path runs.
  const {
    localTabs,
    localActiveId,
    activeLocalTab,
    activeKind,
    setActiveKindCdp,
    createLocalTab,
    closeLocalTab,
    switchLocalTab,
    patchLocalTab,
    toggleLocalPin,
    reorderLocalTabs,
    handleEditLocalSave,
    localQuickLaunch,
    restoreLocalTabs,
  } = useLocalTabs({
    tabsRef,
    pinsRef,
    activeOrderRef,
    closedTabsRef,
    localTabsRef,
    localActiveIdRef,
    activeKindRef,
    localApiRef,
    createLocalTabRef,
    switchTab: (id) => switchTabRef.current?.(id),
  })

  // Theme initialization
  useEffect(() => {
    // Reflect the current DOM theme in the OS chrome immediately, before the async
    // source resolves — keeps the meta honest on first paint (t064).
    syncThemeColorMeta()
    window.cdp.getThemeSource().then((source) => {
      setTheme(source)
      const mq = window.matchMedia("(prefers-color-scheme: dark)")
      systemDarkRef.current = mq.matches
      applyThemeClass(source, mq.matches)
    })

    window.cdp.onNativeThemeChanged((isDark) => {
      systemDarkRef.current = isDark
      setTheme((prev) => {
        applyThemeClass(prev, isDark)
        return prev
      })
    })
  }, [])

  // Load persisted sidebar width + UI state (pins load + link resolution happens
  // in the initial tab-load effect, which needs the live target list).
  useEffect(() => {
    window.cdp.getSidebarWidth().then(setSidebarWidth)
    window.cdp.getUiState().then((s) => {
      setSidebarCollapsed(s.sidebarCollapsed)
      setPinnedOpen(s.pinnedOpen)
      setAdaptiveViewport(s.adaptiveViewport ?? false)
      setForceOnClient(s.forceOnClient ?? false)
      setSwitchEffect(s.switchEffect ?? "blur")
      setNotificationsEnabled(s.notificationsEnabled ?? true)
      setSyncTheme(s.syncTheme ?? true)
      setAutoGrantLocalMedia(s.autoGrantLocalMedia ?? true)
      restoreLocalPinsRef.current = s.restoreLocalPins ?? true
      uiStateLoadedRef.current = true
      // Restore saved local tabs once on launch — the <webview>s mount + load
      // from their persisted urls. Inert on web (the hook is gated).
      if (!localRestoredRef.current && (s.restoreLocalPins ?? true)) {
        localRestoredRef.current = true
        restoreLocalTabs(true)
      }
    })
    window.local.getExtensions().then(setLocalExtensions)
    window.cdp.getNotifications().then(setNotifications)
    window.cdp.onNotification((entry) => {
      setNotifications((prev) => (prev.some((n) => n.id === entry.id) ? prev : [entry, ...prev]))
    })
  }, [restoreLocalTabs])

  // Persist UI state on change (guard avoids overwriting stored values with the
  // initial defaults before getUiState resolves).
  useEffect(() => {
    if (uiStateLoadedRef.current) window.cdp.setUiState({ sidebarCollapsed })
  }, [sidebarCollapsed])
  useEffect(() => {
    if (uiStateLoadedRef.current) window.cdp.setUiState({ pinnedOpen })
  }, [pinnedOpen])
  useEffect(() => {
    settingsOpenRef.current = settingsOpen
  }, [settingsOpen])

  // Drop focus from buttons when the window loses focus, so refocusing the app
  // (e.g. Cmd+Tab back) doesn't re-trigger a focus-driven tooltip. Leave text
  // fields focused so in-progress URL editing survives an app switch.
  useEffect(() => {
    const onBlur = () => {
      const el = document.activeElement as HTMLElement | null
      if (el && el.tagName !== "INPUT" && el.tagName !== "TEXTAREA") {
        el.blur()
      }
    }
    window.addEventListener("blur", onBlur)
    return () => window.removeEventListener("blur", onBlur)
  }, [])

  const handleAdaptiveViewportChange = useCallback((enabled: boolean) => {
    setAdaptiveViewport(enabled)
    window.cdp.setUiState({ adaptiveViewport: enabled })
  }, [])

  const handleForceOnClientChange = useCallback((enabled: boolean) => {
    setForceOnClient(enabled)
    window.cdp.setUiState({ forceOnClient: enabled })
  }, [])

  // Host resize backed adaptive off and auto-recover is disabled: turn the setting off
  // so the toggle reflects it (re-arming is then a normal off→on).
  const handleAdaptivePaused = useCallback(
    () => handleAdaptiveViewportChange(false),
    [handleAdaptiveViewportChange],
  )

  const handleSwitchEffectChange = useCallback((effect: SwitchEffect) => {
    setSwitchEffect(effect)
    window.cdp.setUiState({ switchEffect: effect })
  }, [])

  // Settings drawer open/commit choreography (see the drawer's hybrid close behavior).
  const handleSettingsOpenChange = useCallback((open: boolean) => {
    setSettingsOpen(open)
    if (!open) setSettingsCommitted(false)
  }, [])
  const handleSettingsRequestOpenMouse = useCallback(() => {
    setSettingsOpen(true)
    setSettingsCommitted(false)
  }, [])
  const handleSettingsCommit = useCallback(() => setSettingsCommitted(true), [])

  const handleThemeChange = useCallback((newTheme: ThemeSource) => {
    setTheme(newTheme)
    applyThemeClass(newTheme, systemDarkRef.current)
    window.cdp.setThemeSource(newTheme)
  }, [])

  // Persist the whole pins array (covers link/unlink and reorder). The renderer
  // owns link state; main is the store. Keeps pinsRef in sync for callbacks.
  const persistPins = useCallback((next: Pin[]) => {
    pinsRef.current = next
    setPins(next)
    window.cdp.reorderPins(next)
  }, [])

  // Un-pin keeps any live tab alive — removing the pin un-hides its target, so it
  // returns to the Tabs list.
  const unpinPin = useCallback(async (id: string) => {
    const updated = await window.cdp.removePin(id)
    pinsRef.current = updated
    setPins(updated)
  }, [])

  const handleEditPinSave = useCallback(async (id: string, title: string, pinUrl: string) => {
    const updated = await window.cdp.updatePin(id, { title, url: pinUrl })
    pinsRef.current = updated
    setPins(updated)
  }, [])

  const reorderTabs = useCallback((reordered: TabInfo[]) => {
    tabOrderRef.current = reordered.map((t) => t.id)
    setTabs(reordered)
  }, [])

  // The active tab is "pinned" when a pin currently holds it.
  const activePin = useMemo(
    () => (activeTabId ? pinForTarget(pins, activeTabId) : undefined),
    [pins, activeTabId],
  )

  // Tabs the Tabs list shows = remote targets minus those a pin holds.
  const visibleTabs = useMemo(() => tabs.filter((t) => !pinForTarget(pins, t.id)), [tabs, pins])

  const updateNavHistory = useCallback(async () => {
    const state = await page.getNavState()
    setCanGoBack(state.canGoBack)
    setCanGoForward(state.canGoForward)
  }, [page])

  const refreshTabs = useCallback(async () => {
    const result = await window.cdp.listTabs()
    if (result.error) {
      setStatus(`Error: ${result.error}`)
      return
    }
    const pages = (result as Tab[]).filter((t) => t.type === "page")
    const ordered = (reconcile(tabOrderRef.current, pages) as TabInfo[]).map((t) => ({
      ...t,
      title: stripTitleBadge(t.title),
    }))
    tabOrderRef.current = ordered.map((t) => t.id)
    setTabs(ordered)
    // A pin whose target vanished (closed externally or via close) goes dormant.
    const pruned = dropDeadLinks(pinsRef.current, ordered)
    if (pruned !== pinsRef.current) {
      pinsRef.current = pruned
      setPins(pruned)
      window.cdp.reorderPins(pruned)
    }
    return ordered
  }, [])

  const switchTab = useCallback(
    async (tabId: string) => {
      setActiveKindCdp()
      activeOrderRef.current = planSwitch(activeOrderRef.current, { kind: "cdp", id: tabId })
      // Re-clicking the already-active tab is a no-op — no reconnect, no repaint.
      if (tabId === activeTabIdRef.current) return
      setActiveTabId(tabId)
      setLoading(true)
      setLoadingText("Connecting...")
      setStatus("Connecting...")
      // Freeze/blur immediately, before the connect round-trip.
      setSwitchSignal((s) => s + 1)

      const result = await window.cdp.connect(tabId)
      if (result.error && result.error !== "cancelled") {
        setStatus(`Error: ${result.error}`)
        setLoadingText(`Error: ${result.error}`)
      } else {
        // Overlay means "connecting to CDP" — clear it the moment we're connected.
        // The page's own load progress shows in the toolbar reload button, not here.
        setStatus("Connected")
        setLoading(false)
        setConnectEpoch((e) => e + 1)
        updateNavHistory()
      }
    },
    [updateNavHistory, setActiveKindCdp],
  )
  // Late-bind so the local-tab hook (created before switchTab) can route MRU
  // close/switch fallbacks onto the CDP surface.
  useEffect(() => {
    switchTabRef.current = switchTab
  }, [switchTab])

  // Mark the whole conversation thread read: compute the key, gather unread siblings,
  // flip them all in state, then flush each id to the server. Shared by the click path
  // and the in-box `r` key so the logic lives in exactly one place.
  const markThreadRead = useCallback((entry: NotifEntry) => {
    const key = threadKey(entry)
    const siblings = notificationsRef.current.filter(
      (n) => n.id !== entry.id && !n.read && threadKey(n) === key,
    )
    setNotifications((prev) => prev.map((n) => (threadKey(n) === key ? { ...n, read: true } : n)))
    window.cdp.markNotificationRead(entry.id)
    for (const n of siblings) window.cdp.markNotificationRead(n.id)
  }, [])

  // Clicking a notification (toolbar popover or OS toast) activates the tab that
  // captured it, then dispatches its `activate` intent through the activation registry
  // (keyed by `activate.type`) — no per-adapter branching. The registry maps each
  // variant to a Remote Page deep-open (Outlook → navigateSpa, Teams chats →
  // openTeamsThread). An absent or unknown intent resolves to null → Tab-only.
  // Opening one message marks the whole thread read — the messages collapse into one
  // conversation in the popover, so reading any of them clears the rest.
  const handleNotificationClick = useCallback(
    async (entry: NotifEntry) => {
      setBellOpen(false)
      markThreadRead(entry)
      // A push clicked after the PWA slept can carry a stale targetId (the remote tab was
      // reordered or reopened). Fall back to a live tab sharing the notification's origin.
      const originOf = (u?: string) => {
        try {
          return u ? new URL(u).origin : null
        } catch {
          return null
        }
      }
      const tabsNow = tabsRef.current
      const targetId = tabsNow.some((t) => t.id === entry.targetId)
        ? entry.targetId
        : (tabsNow.find((t) => originOf(t.url) === originOf(entry.targetUrl))?.id ?? entry.targetId)
      await switchTab(targetId)
      // Prefer the normalized `activate` intent; fall back to the legacy `targetEntity`
      // shape so notifications captured before the activate field (still in the backlog)
      // also deep-open.
      const activate = entry.activate ?? deriveLegacyActivate(entry.targetEntity)
      const intention = resolveActivation(activationRegistry, activate)
      if (intention) page[intention.method](intention.arg)
    },
    [switchTab, page, markThreadRead],
  )

  // Opening the popover does NOT mark read — unread clears only via a row click or
  // the explicit "Mark all read", so the dock/tab badges stay meaningful.
  const handleMarkAllRead = useCallback(() => {
    window.cdp.markNotificationsRead()
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })))
  }, [])

  const handleClearNotifications = useCallback(() => {
    window.cdp.clearNotifications()
    setNotifications([])
  }, [])

  // Mark the selected row's whole thread read (the in-box `r` key) without opening it.
  const handleMarkThreadRead = markThreadRead

  // Toggling the per-row indicator flips read state without opening the notification.
  const handleToggleRead = useCallback((entry: NotifEntry) => {
    const read = !entry.read
    setNotifications((prev) => prev.map((n) => (n.id === entry.id ? { ...n, read } : n)))
    if (read) window.cdp.markNotificationRead(entry.id)
    else window.cdp.markNotificationUnread(entry.id)
  }, [])

  // Live tab info for each linked pin (title/favicon/url), so a pin reflects its
  // tab's current title and detects URL drift. Built from the full tab list since
  // linked targets are filtered out of `visibleTabs`.
  const linkedTabByPin = useMemo(() => {
    const m: Record<string, TabInfo> = {}
    for (const pin of pins) {
      if (!pin.targetId) continue
      const t = tabs.find((tab) => tab.id === pin.targetId)
      if (t) m[pin.id] = t
    }
    return m
  }, [pins, tabs])

  // Per-tab and per-pin unread badge counts, grouped so every tab/pin of the same
  // app shares one count and a dormant pin badges by its saved URL's origin.
  const { byTab: unreadByTab, byPin: unreadByPin } = useMemo(
    () => aggregateUnread(notifications, tabs, pins, linkedTabByPin),
    [notifications, tabs, pins, linkedTabByPin],
  )

  const handleNotificationsEnabledChange = useCallback((enabled: boolean) => {
    setNotificationsEnabled(enabled)
    window.cdp.setUiState({ notificationsEnabled: enabled })
  }, [])

  const handleSyncThemeChange = useCallback((enabled: boolean) => {
    setSyncTheme(enabled)
    window.cdp.setUiState({ syncTheme: enabled })
  }, [])

  const handleAutoGrantLocalMediaChange = useCallback((enabled: boolean) => {
    setAutoGrantLocalMedia(enabled)
    window.cdp.setUiState({ autoGrantLocalMedia: enabled })
  }, [])

  const handleAddLocalExtension = useCallback(async () => {
    // Keep the (non-modal) settings drawer open across the native folder picker.
    setSettingsCommitted(true)
    const res = await window.local.pickExtension()
    if ("error" in res) {
      toast.error("Invalid extension", { description: res.error })
      return
    }
    setLocalExtensions(res.extensions)
    toast.success("Extension loaded")
  }, [])

  const handleReloadLocalExtension = useCallback(async (p: string) => {
    const res = await window.local.reloadExtension(p)
    if ("error" in res) {
      toast.error("Reload failed", { description: res.error })
      return
    }
    setLocalExtensions(res.extensions)
    toast.success("Extension reloaded")
  }, [])

  const handleRemoveLocalExtension = useCallback(async (p: string) => {
    const res = await window.local.removeExtension(p)
    if (!("error" in res)) setLocalExtensions(res.extensions)
  }, [])

  // Open an extension surface (action popup / options page) as a local tab —
  // Electron has no browser-chrome toolbar to host the action button.
  const handleOpenExtensionUrl = useCallback((extUrl: string) => {
    setSettingsOpen(false)
    createLocalTabRef.current?.(extUrl)
  }, [])

  const handleOpenActionPopup = useCallback(
    (id: string, anchor: { right: number; bottom: number }) => {
      window.local.openActionPopup(id, anchor)
    },
    [],
  )

  // OS-toast click arrives from main; route it through the same activation path.
  // Use a ref so we only register one ipcRenderer listener (no cleanup API on the
  // bridge), and always call the latest handleNotificationClick without re-registering.
  const handleNotificationClickRef = useRef(handleNotificationClick)
  useEffect(() => {
    handleNotificationClickRef.current = handleNotificationClick
  }, [handleNotificationClick])
  useEffect(() => {
    window.cdp.onNotificationActivate((entry) => handleNotificationClickRef.current(entry))
  }, [])

  // Web PWA auto-update: when a new build's worker finishes installing, surface a
  // dismissible toast; tapping Reload skips waiting and reloads once. No-op under
  // Electron / first install (the watcher guards on an existing controller). See t044.
  useEffect(
    () =>
      startUpdateWatcher((onReload) =>
        toast("Update available", {
          description: "A new version is ready.",
          duration: Number.POSITIVE_INFINITY,
          action: { label: "Reload", onClick: onReload },
        }),
      ),
    [],
  )

  const newTab = useCallback(
    async (tabUrl?: string) => {
      const result = await window.cdp.newTab(tabUrl || "https://www.google.com")
      if (!result.error) {
        await refreshTabs()
        await switchTab(result.id)
      }
    },
    [refreshTabs, switchTab],
  )

  // Show a pin's content: activate its live tab if alive, else open a fresh tab
  // on the saved URL and link it. In-session clicks never adopt an existing tab.
  const activatePin = useCallback(
    async (pin: Pin) => {
      if (pin.targetId && tabsRef.current.some((t) => t.id === pin.targetId)) {
        await switchTab(pin.targetId)
        return
      }
      const result = await window.cdp.newTab(pin.url)
      if (result.error) return
      await refreshTabs()
      persistPins(pinsRef.current.map((p) => (p.id === pin.id ? { ...p, targetId: result.id } : p)))
      await switchTab(result.id)
    },
    [refreshTabs, switchTab, persistPins],
  )

  // Cmd/middle-click: open the URL in a throwaway tab, unlinked from the pin.
  const openPinInNewTab = useCallback((pin: Pin) => newTab(pin.url), [newTab])

  // Pin a tab: link an existing same-URL pin, otherwise create a new linked pin.
  const pinTab = useCallback(
    async (tab: TabInfo) => {
      const existing = pinsRef.current.find((p) => p.url === tab.url)
      if (existing) {
        persistPins(pinsRef.current.map((p) => (p === existing ? { ...p, targetId: tab.id } : p)))
        return
      }
      const newPin: Pin = {
        id: crypto.randomUUID(),
        title: tab.title || tab.url,
        url: tab.url,
        favicon: tab.faviconUrl,
        targetId: tab.id,
      }
      const updated = await window.cdp.addPin(newPin)
      pinsRef.current = updated
      setPins(updated)
    },
    [persistPins],
  )

  // Toolbar star: pin the active tab, or un-pin it if already pinned.
  const togglePin = useCallback(() => {
    const id = activeTabIdRef.current
    if (!id) return
    const held = pinsRef.current.find((p) => p.targetId === id)
    if (held) {
      unpinPin(held.id)
      return
    }
    const tab = tabsRef.current.find((t) => t.id === id)
    if (tab) pinTab(tab)
  }, [pinTab, unpinPin])

  const closeTab = useCallback(
    async (tabId: string) => {
      const tab = tabsRef.current.find((t) => t.id === tabId)
      const wasActive = tabId === activeTabIdRef.current

      await window.cdp.closeTab(tabId)

      // Remove from local tab order immediately
      tabOrderRef.current = tabOrderRef.current.filter((id) => id !== tabId)

      if (wasActive) {
        setActiveTabId(null)
        setLoading(true)
        setLoadingText("No tab selected")
      }

      // Small delay for remote browser to finish closing
      await new Promise((r) => setTimeout(r, 300))

      const ordered = await refreshTabs()
      // The pin-revert effect is already applied by refreshTabs' dropDeadLinks
      // (the closed target vanished from the live set); the planner just confirms.
      const directive = planClose({
        kind: "cdp",
        id: tabId,
        url: tab?.url ?? "",
        wasActive,
        order: activeOrderRef.current,
        tabs: (ordered ?? []).filter((t) => !pinForTarget(pinsRef.current, t.id)),
        locals: localTabsRef.current,
        pins: pinsRef.current,
      })
      if (tab?.url) closedTabsRef.current.push(directive.closedEntry)
      activeOrderRef.current = dropActive(activeOrderRef.current, { kind: "cdp", id: tabId })
      if (directive.nextActive?.kind === "cdp") await switchTab(directive.nextActive.id)
      else if (directive.nextActive?.kind === "local") switchLocalTab(directive.nextActive.id)
    },
    [refreshTabs, switchTab, switchLocalTab],
  )

  // Changing the CDP address invalidates all tab IDs, so reconnect to the
  // first tab on the new host instead of waiting for a manual tab switch.
  const handleConfigSaved = useCallback(async () => {
    const ordered = await refreshTabs()
    if (ordered && ordered.length > 0) {
      switchTab(ordered[0].id)
    } else {
      setActiveTabId(null)
      setLoading(true)
      setLoadingText("No tab selected")
    }
  }, [refreshTabs, switchTab])

  // Open the unified new-tab dialog seeded to a kind (active tab's kind for Cmd+T).
  const openNewTab = useCallback((kind: NewTabKind) => {
    setNewTabKind(kind)
    setNewTabOpen(true)
  }, [])

  // Reveal the Cmd+number hints after the modifier is held ~1s.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const reset = () => {
      clearTimeout(timer)
      setCmdHeld(false)
    }
    const down = (e: KeyboardEvent) => {
      if (e.key === "Meta" && !e.repeat) timer = setTimeout(() => setCmdHeld(true), 1000)
    }
    const up = (e: KeyboardEvent) => {
      if (e.key === "Meta") reset()
    }
    window.addEventListener("keydown", down)
    window.addEventListener("keyup", up)
    window.addEventListener("blur", reset)
    return () => {
      window.removeEventListener("keydown", down)
      window.removeEventListener("keyup", up)
      window.removeEventListener("blur", reset)
      clearTimeout(timer)
    }
  }, [])

  const reopenClosedTab = useCallback(async () => {
    const entry = closedTabsRef.current.pop()
    if (!entry) return
    if (entry.kind === "local") await createLocalTab(entry.url)
    else await newTab(entry.url)
  }, [newTab, createLocalTab])

  const navigate = useCallback(
    (navUrl: string) => {
      let u = navUrl
      if (!u.match(/^https?:\/\//)) u = `https://${u}`
      setUrl(u)
      if (activeKindRef.current === "local" && localActiveIdRef.current) {
        localApiRef.current?.navigate(localActiveIdRef.current, u)
      } else {
        page.navigate(u)
      }
    },
    [page],
  )

  // Favicon "Back to Pinned URL": activate the pin's tab (if not already) then
  // navigate it back to the saved pinned URL.
  const backToPinnedUrl = useCallback(
    async (pin: Pin) => {
      if (!pin.targetId) return
      if (activeTabIdRef.current !== pin.targetId) await switchTab(pin.targetId)
      navigate(pin.url)
    },
    [switchTab, navigate],
  )

  // Bulk-close helpers for the tab context menu. They operate on the visible Tabs
  // list (pins are untouched). Closes happen in parallel, then one refresh.
  const closeTabs = useCallback(
    async (ids: string[]) => {
      if (ids.length === 0) return
      const closingActive = ids.includes(activeTabIdRef.current ?? "")
      for (const id of ids) {
        const tab = tabsRef.current.find((t) => t.id === id)
        if (tab?.url) closedTabsRef.current.push({ kind: "cdp", url: tab.url })
      }
      tabOrderRef.current = tabOrderRef.current.filter((id) => !ids.includes(id))
      if (closingActive) {
        setActiveTabId(null)
        setLoading(true)
        setLoadingText("No tab selected")
      }
      for (const id of ids) {
        activeOrderRef.current = dropActive(activeOrderRef.current, { kind: "cdp", id })
      }
      await Promise.all(ids.map((id) => window.cdp.closeTab(id)))
      await new Promise((r) => setTimeout(r, 300))
      const ordered = await refreshTabs()
      if (closingActive) {
        // Closed refs are already dropped from the order above, so the planner's
        // own drop is a no-op here; we reuse it only for the fallback selection.
        const directive = planClose({
          kind: "cdp",
          id: activeTabIdRef.current ?? "",
          url: "",
          wasActive: true,
          order: activeOrderRef.current,
          tabs: (ordered ?? []).filter((t) => !pinForTarget(pinsRef.current, t.id)),
          locals: localTabsRef.current,
          pins: pinsRef.current,
        })
        if (directive.nextActive?.kind === "cdp") await switchTab(directive.nextActive.id)
        else if (directive.nextActive?.kind === "local") switchLocalTab(directive.nextActive.id)
      }
    },
    [refreshTabs, switchTab, switchLocalTab],
  )

  const goBack = useCallback(() => {
    const id = localActiveIdRef.current
    if (activeKindRef.current === "local" && id) localApiRef.current?.back(id)
    else page.back()
  }, [page])
  const goForward = useCallback(() => {
    const id = localActiveIdRef.current
    if (activeKindRef.current === "local" && id) localApiRef.current?.forward(id)
    else page.forward()
  }, [page])
  const reload = useCallback(() => {
    const id = localActiveIdRef.current
    if (activeKindRef.current === "local" && id) localApiRef.current?.reload(id)
    else page.reload()
  }, [page])

  const activateRow = useCallback(
    (row: NavRow) => {
      if (row.kind === "pin") activatePin(row.pin)
      else if (row.kind === "local") switchLocalTab(row.id)
      else switchTab(row.id)
    },
    [activatePin, switchTab, switchLocalTab],
  )

  // Cmd+1..9 indexes, top→bottom as shown: pins, then CDP tabs, then local tabs.
  const indexRows = useMemo<NavRow[]>(
    () => [
      ...pins.map((p) => ({ kind: "pin" as const, pin: p })),
      ...visibleTabs.map((t) => ({ kind: "tab" as const, id: t.id })),
      ...localTabs.map((t) => ({ kind: "local" as const, id: t.id })),
    ],
    [pins, visibleTabs, localTabs],
  )

  // Ctrl+Tab cycles existing views — pins holding a tab, CDP tabs, local tabs.
  const cycleRows = useMemo<NavRow[]>(
    () => [
      ...pins.filter((p) => p.targetId).map((p) => ({ kind: "pin" as const, pin: p })),
      ...visibleTabs.map((t) => ({ kind: "tab" as const, id: t.id })),
      ...localTabs.map((t) => ({ kind: "local" as const, id: t.id })),
    ],
    [pins, visibleTabs, localTabs],
  )

  const cycleBy = useCallback(
    (delta: number) => {
      if (cycleRows.length === 0) return
      const matchesCurrent = (r: NavRow) =>
        r.kind === "local"
          ? activeKind === "local" && r.id === localActiveId
          : activeKind === "cdp" && (r.kind === "pin" ? r.pin.targetId : r.id) === activeTabId
      const cur = cycleRows.findIndex(matchesCurrent)
      const base = cur === -1 ? (delta > 0 ? -1 : 0) : cur
      const next = (base + delta + cycleRows.length) % cycleRows.length
      activateRow(cycleRows[next])
    },
    [cycleRows, activeTabId, localActiveId, activeKind, activateRow],
  )

  const switchToNextTab = useCallback(() => cycleBy(1), [cycleBy])
  const switchToPrevTab = useCallback(() => cycleBy(-1), [cycleBy])

  // Cmd+1..9 → the Nth indexed row (literal, since the numbers are shown on hold).
  const switchToTabIndex = useCallback(
    (index: number) => {
      const row = indexRows[index]
      if (row) activateRow(row)
    },
    [indexRows, activateRow],
  )

  // Keep refs in sync
  useEffect(() => {
    tabsRef.current = tabs
  }, [tabs])
  useEffect(() => {
    notificationsRef.current = notifications
  }, [notifications])
  useEffect(() => {
    pinsRef.current = pins
  }, [pins])
  useEffect(() => {
    activeTabIdRef.current = activeTabId
  }, [activeTabId])

  // Close the active surface (a pinned local tab is a persistent holder — Cmd+W / Ctrl+W
  // keeps it, like a CDP pin). Declared before the keydown effect so both W branches can
  // call it directly.
  const closeActive = useCallback(() => {
    if (activeKindRef.current === "local") {
      const id = localActiveIdRef.current
      const pinned = localTabsRef.current.find((t) => t.id === id)?.pinned
      if (id && !pinned) closeLocalTab(id)
    } else if (activeTabIdRef.current) {
      closeTab(activeTabIdRef.current)
    }
  }, [closeLocalTab, closeTab])

  // Update URL when active tab changes
  useEffect(() => {
    const tab = tabs.find((t) => t.id === activeTabId)
    if (tab) setUrl(tab.url || "")
  }, [activeTabId, tabs])

  // CDP events — demuxed by the Remote Page into a typed stream
  useEffect(() => {
    let windowOpenedTimer: ReturnType<typeof setTimeout> | undefined
    const offEvent = page.on((e) => {
      switch (e.type) {
        case "navigated":
          setUrl(e.url)
          refreshTabs()
          updateNavHistory()
          break
        case "loadingChanged":
          setPageLoading(e.loading)
          // Any load activity means we're past the connect overlay; show content.
          setLoading(false)
          // frameNavigated is unreliable for history navigations; refresh on settle.
          if (!e.loading) updateNavHistory()
          break
        case "windowOpened":
          windowOpenedTimer = setTimeout(() => refreshTabs(), 500)
          break
        case "disconnected":
          // Web auto-reconnect (t040): "reconnecting" is progress (the backoff loop is
          // retrying) — show a spinner, not an error. A resumed frame clears it back to
          // "Connected" (onFrame below). "lost"/undefined is terminal — surface the error
          // status with the Connection-settings affordance.
          if (e.phase === "reconnecting") {
            setLoading(true)
            setLoadingText("Reconnecting…")
            setStatus("Reconnecting…")
          } else {
            setStatus("Disconnected")
            setLoading(true)
            setLoadingText("Error: Disconnected")
          }
          break
      }
    })
    // First screencast frame means the connection is live.
    const offFrame = page.onFrame(() => {
      setLoading(false)
      setStatus("Connected")
    })
    return () => {
      offEvent()
      offFrame()
      clearTimeout(windowOpenedTimer)
    }
  }, [page, refreshTabs, updateNavHistory])

  // Trackpad swipe gestures
  useEffect(() => {
    window.cdp.onSwipe((direction) => {
      if (direction === "left") goBack()
      if (direction === "right") goForward()
    })
  }, [goBack, goForward])

  // Global hotkeys (capture phase to intercept before CDP forwarding)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // An editable surface (URL bar, a remote input via the webview, etc.) owns plain keys.
      const target = e.target as HTMLElement | null
      const inInput =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable === true

      // ? : shortcut-help overlay (when app chrome is focused). Plain key (Shift+/),
      // so never while an input owns it OR while the canvas/webview is the active
      // typing surface (then ? types literally into the remote page).
      if (
        e.key === "?" &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !inInput &&
        !isTypingSurface(activeKind)
      ) {
        e.preventDefault()
        e.stopPropagation()
        setShortcutsOpen((prev) => !prev)
        return
      }

      // ⌘/ : alternative opener for shortcut-help overlay, reachable everywhere
      // except a local input. Avoids bare ? firing over the canvas.
      if ((e.metaKey || e.ctrlKey) && e.key === "/" && !e.altKey && !inInput) {
        e.preventDefault()
        e.stopPropagation()
        setShortcutsOpen((prev) => !prev)
        return
      }

      // ⌘K / Ctrl+K: command palette. Reachable everywhere except an input owning the key.
      // Match physical e.code so a Vietnamese engine's synthetic key re-post can't trip it.
      if ((e.metaKey || e.ctrlKey) && e.code === "KeyK" && !inInput) {
        e.preventDefault()
        e.stopPropagation()
        setPaletteOpen((prev) => !prev)
        return
      }

      // ⌥N: toggle the notification box. Match on e.code — Option rewrites e.key to a
      // dead-key glyph on macOS. No metaKey/ctrlKey so it's a dedicated Alt combo; never
      // while an input owns it.
      if (e.altKey && !e.metaKey && !e.ctrlKey && e.code === "KeyN" && !inInput) {
        e.preventDefault()
        e.stopPropagation()
        setBellOpen((v) => !v)
        return
      }

      // Ctrl+Tab / Ctrl+Shift+Tab: switch tabs
      if (e.ctrlKey && e.key === "Tab") {
        e.preventDefault()
        e.stopPropagation()
        if (e.shiftKey) {
          switchToPrevTab()
        } else {
          switchToNextTab()
        }
        return
      }

      // Ctrl+R / Ctrl+W: reload / close the active tab. The natural Cmd+R / Cmd+W are
      // reserved by iOS standalone WebKit — it reloads/closes the PWA itself before the
      // page sees the event, so preventDefault can't reclaim them (other Cmd shortcuts
      // are delivered normally; only the browser-reserved pair is intercepted). Ctrl is
      // not reserved (Ctrl+Tab already works), so these are the working keyboard path on
      // the iPad. Matched on e.code so casing/layout can't miss. Skipped in inputs so
      // Ctrl+W keeps its word-delete there. The Cmd variants stay below for Electron/desktop.
      // Gated to web only so Electron's Ctrl+W/R still reach the remote page forwarding path.
      if (caps.web && e.ctrlKey && !e.metaKey && !e.altKey && !inInput) {
        if (e.code === "KeyR") {
          e.preventDefault()
          e.stopPropagation()
          reload()
          return
        }
        if (e.code === "KeyW") {
          e.preventDefault()
          e.stopPropagation()
          closeActive()
          return
        }
      }

      if (!e.metaKey) return

      // Cmd+1..9: jump to the Nth indexed item (pins → CDP → local).
      if (!e.altKey && e.code.startsWith("Digit")) {
        const n = Number(e.code.slice(5))
        if (n >= 1 && n <= 9) {
          e.preventDefault()
          e.stopPropagation()
          switchToTabIndex(n - 1)
          return
        }
      }

      // Cmd+Shift+T: reopen closed tab. Match on the physical e.code, not e.key —
      // Shift+Cmd casing varies by platform, and a Vietnamese input engine (EVKey,
      // OpenKey) re-posts characters as synthetic key events with a non-physical key
      // while fixing a word, which e.key matching would misread (see the switch below).
      if (e.shiftKey && e.code === "KeyT") {
        e.preventDefault()
        e.stopPropagation()
        reopenClosedTab()
        return
      }

      // Cmd+Alt combos
      if (e.altKey) {
        switch (e.code) {
          case "KeyL": // Cmd+Opt+L: copy URL
            e.preventDefault()
            e.stopPropagation()
            if (url) window.cdp.copyToClipboard(url)
            return
        }
      }

      // Punctuation shortcuts stay on e.key, not e.code. e.code is Shift-blind, so
      // Cmd+Shift+[ / Cmd+Shift+] (the browser prev/next-tab combo) must fall through to
      // the remote page — e.key is "{"/"}" there and naturally won't match. e.code is also
      // layout-fragile (a non-US layout's comma sits on a different physical key, e.g.
      // Dvorak's comma is the QWERTY-W key — matching e.code would close the tab). And
      // punctuation isn't a Telex tone-rewrite vector, so the synthetic-injection risk
      // that drives the e.code switch below doesn't apply here.
      if (e.key === ",") {
        e.preventDefault()
        e.stopPropagation()
        const next = !settingsOpenRef.current
        setSettingsOpen(next)
        setSettingsCommitted(next) // keyboard-opened drawers start committed
        return
      }
      if (e.key === "[") {
        e.preventDefault()
        e.stopPropagation()
        goBack()
        return
      }
      if (e.key === "]") {
        e.preventDefault()
        e.stopPropagation()
        goForward()
        return
      }

      // Match on the physical e.code, not e.key. Two reasons: iPadOS WebKit can report
      // Cmd+letter as the uppercase letter (which e.key matching would miss, letting the
      // browser's reserved Cmd+R/Cmd+W fire); and a Vietnamese input engine (EVKey,
      // OpenKey) re-posts characters as synthetic key events while fixing a word
      // mid-syllable (e.g. Telex "chajy" → "chạy"). Those injected events can carry a
      // stray Cmd flag with a non-physical key — matching e.key would misread one as
      // Cmd+L and yank focus to the URL bar mid-typing. A real shortcut always carries a
      // physical e.code ("KeyL"); the synthetic injection does not, so it falls through
      // here and is forwarded to the remote page untouched.
      switch (e.code) {
        case "KeyT":
          e.preventDefault()
          e.stopPropagation()
          openNewTab(activeKindRef.current)
          break
        case "KeyW":
          e.preventDefault()
          e.stopPropagation()
          closeActive()
          break
        case "KeyD":
          e.preventDefault()
          e.stopPropagation()
          togglePin()
          break
        case "KeyL":
          e.preventDefault()
          e.stopPropagation()
          toolbarRef.current?.focusUrlBar()
          break
        case "KeyS":
          e.preventDefault()
          e.stopPropagation()
          setSidebarCollapsed((prev) => !prev)
          break
        case "KeyR":
          e.preventDefault()
          e.stopPropagation()
          reload()
          break
        case "KeyF":
          e.preventDefault()
          e.stopPropagation()
          findBarRef.current?.open()
          break
        case "KeyC": {
          // Cmd+C: copy selected text from remote browser to local clipboard
          const target = e.target as HTMLElement
          if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") break // let native copy work
          e.preventDefault()
          e.stopPropagation()
          page.copySelection().then((text) => {
            if (text) window.cdp.copyToClipboard(text)
          })
          break
        }
        case "KeyV": {
          // Cmd+V: paste from local clipboard into remote page
          const target = e.target as HTMLElement
          if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") break // let native paste work
          // Web: navigator.clipboard.readText() is blocked on Safari/iPad PWA. Don't handle
          // here — let the browser's native `paste` event fire (see the paste listener
          // effect), which is gesture-bound, permission-free, and also carries images.
          if (caps.web) break
          e.preventDefault()
          e.stopPropagation()
          // Electron: read the local clipboard in main (image first, then text) and inject.
          window.cdp
            .readClipboardImage()
            .then((dataUrl) => {
              if (dataUrl) {
                page.pasteImage(dataUrl)
                return
              }
              return window.cdp.readClipboard().then((text) => {
                if (text) page.paste(text, { rich: false })
              })
            })
            .catch(() => {
              // clipboard read failed; silently ignore (no permission, not focused, etc)
            })
          break
        }
        case "KeyA": {
          // Cmd+A: select all on remote page
          const target = e.target as HTMLElement
          if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") break
          e.preventDefault()
          e.stopPropagation()
          page.selectAll()
          break
        }
      }
    }
    document.addEventListener("keydown", handleKeyDown, true)
    return () => document.removeEventListener("keydown", handleKeyDown, true)
  }, [
    closeActive,
    openNewTab,
    togglePin,
    reopenClosedTab,
    reload,
    goBack,
    goForward,
    switchToNextTab,
    switchToPrevTab,
    switchToTabIndex,
    url,
    page,
    caps.web,
  ])

  // Web clipboard paste (t065). On Safari/iPad PWA navigator.clipboard.readText() is
  // blocked, so we read from the native `paste` event instead — gesture-bound,
  // permission-free, and it carries images too. The Cmd+V keydown is left un-prevented on
  // web (see the "v" case + viewport's isPasteCombo skip) so the browser fires this event.
  useEffect(() => {
    if (!caps.web) return
    const onPaste = (e: ClipboardEvent) => {
      const el = document.activeElement as HTMLElement | null
      // A local input/textarea/contenteditable owns the paste — let it paste natively.
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable))
        return
      const dt = e.clipboardData
      if (!dt) return
      const imageItem = Array.from(dt.items).find(
        (it) => it.kind === "file" && it.type.startsWith("image/"),
      )
      if (imageItem) {
        const file = imageItem.getAsFile()
        if (file) {
          e.preventDefault()
          const reader = new FileReader()
          reader.onload = () => {
            if (typeof reader.result === "string") page.pasteImage(reader.result)
          }
          reader.readAsDataURL(file)
          return
        }
      }
      const text = dt.getData("text/plain")
      if (text) {
        e.preventDefault()
        page.paste(text, { rich: false })
      }
    }
    document.addEventListener("paste", onPaste)
    return () => document.removeEventListener("paste", onPaste)
  }, [page])

  // Initial load: resolve pin links against the live targets, then activate the
  // first visible tab. Pins re-link to their persisted target (or a URL match)
  // so they survive a restart.
  useEffect(() => {
    let cancelled = false
    const init = async () => {
      const [loadedPins, ordered] = await Promise.all([window.cdp.getPins(), refreshTabs()])
      if (cancelled || !ordered) return
      const resolved = loadedPins.map((p) => {
        const targetId = resolvePinLink(p, ordered)
        if (targetId === p.targetId) return p
        if (targetId) return { ...p, targetId }
        const { targetId: _gone, ...rest } = p
        return rest
      })
      pinsRef.current = resolved
      setPins(resolved)
      if (resolved.some((p, i) => p !== loadedPins[i])) window.cdp.reorderPins(resolved)
      const first = ordered.find((t) => !pinForTarget(resolved, t.id)) ?? ordered[0]
      if (first) switchTab(first.id)
    }
    init()
    const interval = setInterval(refreshTabs, 3000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [refreshTabs, switchTab])

  // Toolbar/URL bar reflect whichever surface is active.
  const isLocal = activeKind === "local"
  const effectiveUrl = isLocal ? (activeLocalTab?.url ?? "") : url
  const effectiveCanGoBack = isLocal ? !!activeLocalTab?.canGoBack : canGoBack
  const effectiveCanGoForward = isLocal ? !!activeLocalTab?.canGoForward : canGoForward
  const effectiveIsPinned = isLocal ? !!activeLocalTab?.pinned : activePin != null
  const handleTogglePin = useCallback(() => {
    if (activeKindRef.current === "local") {
      if (localActiveIdRef.current) toggleLocalPin(localActiveIdRef.current)
    } else togglePin()
  }, [togglePin, toggleLocalPin])
  const handlePageLoading = isLocal ? !!activeLocalTab?.loading : pageLoading

  const copyAddress = useCallback(() => {
    if (effectiveUrl) window.cdp.copyToClipboard(effectiveUrl)
  }, [effectiveUrl])

  // Cycle the echo-cursor visibility mode off → on → auto → off. ui-state is the single
  // owner (persisted server-side; viewport.tsx reads it live via the dispatch event).
  const cycleVirtualPointer = useCallback(async () => {
    const s = await window.cdp.getUiState()
    const next = nextVirtualPointerMode(parseMode(s[VIRTUAL_POINTER_MODE_KEY]))
    window.cdp.setUiState({ [VIRTUAL_POINTER_MODE_KEY]: next })
    dispatchVirtualPointerMode(next)
    toast(`Virtual pointer: ${next}`)
  }, [])

  // The ⌘K palette and `?` overlay read this one list (the hotkey registry), so every
  // action shows its shortcut and the overlay stays in sync with zero drift. Each run-fn
  // points at the *existing* handler the keydown switch / toolbar already calls — the
  // palette is presentation, never a second copy of the effect logic. Electron-only
  // actions (new local tab) are spliced in via the caps flag, hidden on web.
  const paletteActions = useMemo<Action[]>(() => {
    const switchActions: Action[] = [
      ...pins.map(
        (p): Action => ({
          id: `pin-${p.id}`,
          name: `Switch to ${p.title || p.url}`,
          group: "Tab navigation",
          run: () => activatePin(p),
        }),
      ),
      ...visibleTabs.map(
        (t): Action => ({
          id: `tab-${t.id}`,
          name: `Switch to ${t.title || t.url}`,
          group: "Tab navigation",
          run: () => switchTab(t.id),
        }),
      ),
      ...localTabs.map(
        (t): Action => ({
          id: `local-${t.id}`,
          name: `Switch to ${t.title || t.url}`,
          group: "Tab navigation",
          run: () => switchLocalTab(t.id),
        }),
      ),
    ]
    return buildActions([
      {
        id: "new-tab",
        name: "Open new tab",
        group: "Global",
        hotkey: "⌘T",
        run: () => openNewTab("cdp"),
      },
      caps.localTabs && {
        id: "new-local-tab",
        name: "Open new local tab",
        group: "Global",
        run: () => openNewTab("local"),
      },
      {
        id: "close-tab",
        name: "Close active tab",
        group: "Global",
        // iOS standalone WebKit reserves ⌘W (and ⌘R) — the page can't override them — so
        // the web/PWA surface uses the non-reserved ⌃ variant (both are wired in the keydown
        // handler). Electron keeps ⌘.
        hotkey: caps.web ? "⌃W" : "⌘W",
        run: closeActive,
      },
      {
        id: "reopen-tab",
        name: "Reopen last closed tab",
        group: "Global",
        hotkey: "⌘⇧T",
        run: reopenClosedTab,
      },
      {
        id: "reload",
        name: "Reload page",
        group: "Global",
        hotkey: caps.web ? "⌃R" : "⌘R",
        run: reload,
      },
      {
        id: "find",
        name: "Find in page",
        group: "Global",
        hotkey: "⌘F",
        run: () => findBarRef.current?.open(),
      },
      {
        id: "focus-url",
        name: "Focus address bar",
        group: "Address bar",
        hotkey: "⌘L",
        run: () => toolbarRef.current?.focusUrlBar(),
      },
      {
        id: "copy-address",
        name: "Copy address",
        group: "Address bar",
        hotkey: "⌘⌥L",
        run: copyAddress,
      },
      {
        id: "settings",
        name: "Open Settings",
        group: "Global",
        hotkey: "⌘,",
        run: handleSettingsRequestOpenMouse,
      },
      {
        id: "toggle-sidebar",
        name: "Toggle sidebar",
        group: "Sidebar",
        hotkey: "⌘S",
        run: () => setSidebarCollapsed((prev) => !prev),
      },
      {
        id: "toggle-pin",
        name: effectiveIsPinned ? "Unpin this tab" : "Pin this tab",
        group: "Global",
        hotkey: "⌘D",
        run: handleTogglePin,
      },
      {
        id: "toggle-adaptive",
        name: `${adaptiveViewport ? "Disable" : "Enable"} Adaptive Viewport`,
        group: "Global",
        run: () => handleAdaptiveViewportChange(!adaptiveViewport),
      },
      {
        id: "toggle-notifications",
        name: `${notificationsEnabled ? "Disable" : "Enable"} notifications`,
        group: "Global",
        run: () => handleNotificationsEnabledChange(!notificationsEnabled),
      },
      {
        id: "toggle-notification-box",
        name: "Toggle notifications",
        group: "Global",
        hotkey: "⌥N",
        run: () => setBellOpen((v) => !v),
      },
      {
        id: "toggle-virtual-pointer",
        name: "Toggle virtual pointer",
        group: "Global",
        run: cycleVirtualPointer,
      },
      {
        id: "next-tab",
        name: "Next tab",
        group: "Tab navigation",
        hotkey: "⌃Tab",
        run: switchToNextTab,
      },
      {
        id: "prev-tab",
        name: "Previous tab",
        group: "Tab navigation",
        hotkey: "⌃⇧Tab",
        run: switchToPrevTab,
      },
      window.cdp.reconnect && {
        id: "reconnect",
        name: "Reconnect",
        group: "Global",
        run: () => window.cdp.reconnect?.(),
      },
      ...switchActions,
    ])
  }, [
    pins,
    visibleTabs,
    localTabs,
    activatePin,
    switchTab,
    switchLocalTab,
    openNewTab,
    closeActive,
    reopenClosedTab,
    reload,
    copyAddress,
    handleSettingsRequestOpenMouse,
    effectiveIsPinned,
    handleTogglePin,
    adaptiveViewport,
    handleAdaptiveViewportChange,
    notificationsEnabled,
    handleNotificationsEnabledChange,
    cycleVirtualPointer,
    switchToNextTab,
    switchToPrevTab,
    caps.localTabs,
    caps.web,
  ])

  return (
    <TooltipProvider delayDuration={300}>
      {/* Top safe-area inset is reserved ONCE here at the app root so the toolbar and the
          sidebar header are identical-height (min-h-11) bars that align — applying the inset
          per-bar grew the content-bearing toolbar past the empty sidebar header. */}
      <div className="flex h-full pt-[max(0px,env(safe-area-inset-top))]">
        <Sidebar
          activeTabId={activeKind === "cdp" ? activeTabId : null}
          collapsed={sidebarCollapsed}
          linkedTabByPin={linkedTabByPin}
          localActiveId={activeKind === "local" ? localActiveId : null}
          localTabs={localTabs}
          onActivatePin={activatePin}
          onBackToPinnedUrl={backToPinnedUrl}
          onCloseLocalTab={closeLocalTab}
          onClosePin={(p) => p.targetId && closeTab(p.targetId)}
          onCloseTab={closeTab}
          onCloseTabs={closeTabs}
          onEditLocalTab={setEditingLocalId}
          onEditPin={setEditingPin}
          onNewLocalTab={() => openNewTab("local")}
          onNewTab={() => openNewTab("cdp")}
          onOpenPinInNewTab={openPinInNewTab}
          onPinnedToggle={() => setPinnedOpen((prev) => !prev)}
          onPinTab={pinTab}
          onReorderLocalTabs={reorderLocalTabs}
          onReorderPins={persistPins}
          onReorderTabs={reorderTabs}
          onResize={setSidebarWidth}
          onResizeEnd={(w) => window.cdp.setSidebarWidth(w)}
          onSwitchLocalTab={switchLocalTab}
          onSwitchTab={switchTab}
          onToggleLocalPin={toggleLocalPin}
          onUnpinPin={unpinPin}
          pinnedOpen={pinnedOpen}
          pins={pins}
          showNumbers={cmdHeld}
          tabs={visibleTabs}
          unreadByPin={unreadByPin}
          unreadByTab={unreadByTab}
          width={sidebarWidth}
        />
        {/* `relative` so the floating StatusBar pins to the bottom edge without reserving
            layout height. No bottom inset reservation: the content runs full-bleed to the
            physical bottom (under the home indicator) — no reserved strip. */}
        <div className="relative flex flex-1 flex-col min-w-0">
          <Toolbar
            adaptiveViewport={adaptiveViewport}
            autoGrantLocalMedia={autoGrantLocalMedia}
            bellOpen={bellOpen}
            canGoBack={effectiveCanGoBack}
            canGoForward={effectiveCanGoForward}
            emulatedSize={emulatedSize}
            forceOnClient={forceOnClient}
            fps={fps}
            isLocalActive={isLocal}
            isPinned={effectiveIsPinned}
            localExtensions={localExtensions}
            notifications={notifications}
            notificationsEnabled={notificationsEnabled}
            onAdaptiveViewportChange={handleAdaptiveViewportChange}
            onAddLocalExtension={handleAddLocalExtension}
            onAutoGrantLocalMediaChange={handleAutoGrantLocalMediaChange}
            onBack={goBack}
            onBellOpenChange={setBellOpen}
            onClearNotifications={handleClearNotifications}
            onConfigSaved={handleConfigSaved}
            onForceOnClientChange={handleForceOnClientChange}
            onForward={goForward}
            onMarkAllRead={handleMarkAllRead}
            onMarkThreadRead={handleMarkThreadRead}
            onNavigate={navigate}
            onNotificationClick={handleNotificationClick}
            onNotificationsEnabledChange={handleNotificationsEnabledChange}
            onNotificationToggleRead={handleToggleRead}
            onOpenActionPopup={handleOpenActionPopup}
            onOpenCommandPalette={() => setPaletteOpen(true)}
            onOpenExtensionUrl={handleOpenExtensionUrl}
            onOpenFind={() => findBarRef.current?.open()}
            onReload={reload}
            onReloadLocalExtension={handleReloadLocalExtension}
            onRemoveLocalExtension={handleRemoveLocalExtension}
            onSettingsCommit={handleSettingsCommit}
            onSettingsOpenChange={handleSettingsOpenChange}
            onSettingsRequestOpenMouse={handleSettingsRequestOpenMouse}
            onSwitchEffectChange={handleSwitchEffectChange}
            onSyncThemeChange={handleSyncThemeChange}
            onThemeChange={handleThemeChange}
            onTogglePin={handleTogglePin}
            onToggleSidebar={() => setSidebarCollapsed(!sidebarCollapsed)}
            pageLoading={handlePageLoading}
            ref={toolbarRef}
            settingsCommitted={settingsCommitted}
            settingsOpen={settingsOpen}
            sidebarCollapsed={sidebarCollapsed}
            status={status}
            switchEffect={switchEffect}
            syncTheme={syncTheme}
            theme={theme}
            url={effectiveUrl}
          />
          <div className="relative flex flex-1 min-h-0">
            {/* CDP screencast canvas (hidden when a local tab is active). */}
            <div className={cn("relative z-0 flex flex-1 min-w-0", isLocal && "hidden")}>
              <Viewport
                adaptiveEnabled={adaptiveViewport}
                connectEpoch={connectEpoch}
                forceOnClient={forceOnClient}
                onAdaptivePaused={handleAdaptivePaused}
                onEmulatedSizeChange={setEmulatedSize}
                onFpsUpdate={setFps}
                onResolutionUpdate={setResolution}
                page={page}
                switchEffect={switchEffect}
                switchSignal={switchSignal}
              />
              {/* In-page find overlay — stacks above the screencast canvas via z-index
                  (ADR-0005). CDP page only; local tabs have native find. */}
              <FindBar page={page} ref={findBarRef} />
            </div>
            {/* Local tabs as live <webview>s — React overlays stack above via
                z-index, so no freeze/snapshot is needed. Electron only: the web
                build (caps.localTabs false) never mounts the webview host. */}
            {caps.localTabs && (
              <LocalWebviews
                activeId={localActiveId}
                apiRef={localApiRef}
                onOpenUrl={(u) => createLocalTab(u)}
                onPatch={patchLocalTab}
                tabs={localTabs}
                visible={isLocal}
              />
            )}
          </div>
          <StatusBar
            // Web-only: the HUD reads web-transport metrics, so no slot on Electron (t059).
            latencyHud={caps.web ? <LatencyHud /> : undefined}
            loading={loading}
            loadingText={loadingText}
            onOpenSettings={handleSettingsRequestOpenMouse}
            onReconnect={window.cdp.reconnect ? () => window.cdp.reconnect?.() : undefined}
          />
        </div>
        <NewTabDialog
          cdpPins={pins}
          initialKind={newTabKind}
          localEnabled={caps.localTabs}
          localPins={localQuickLaunch}
          onActivatePin={(kind, p) => (kind === "cdp" ? activatePin(p) : switchLocalTab(p.id))}
          onOpenChange={setNewTabOpen}
          onOpenUrl={(kind, u) => (kind === "cdp" ? newTab(u) : createLocalTab(u))}
          open={newTabOpen}
        />
        <EditPinDialog
          liveUrl={
            editingPin?.targetId ? tabs.find((t) => t.id === editingPin.targetId)?.url : undefined
          }
          onOpenChange={(open) => !open && setEditingPin(null)}
          onSave={handleEditPinSave}
          open={editingPin != null}
          pin={editingPin}
        />
        <EditPinDialog
          onOpenChange={(open) => !open && setEditingLocalId(null)}
          onSave={handleEditLocalSave}
          open={editingLocalId != null}
          pin={(() => {
            const t = localTabs.find((x) => x.id === editingLocalId)
            return t ? { id: t.id, title: t.title, url: t.url, favicon: t.favicon } : null
          })()}
        />
        <CommandPalette actions={paletteActions} onOpenChange={setPaletteOpen} open={paletteOpen} />
        <ShortcutOverlay
          actions={paletteActions}
          onOpenChange={setShortcutsOpen}
          open={shortcutsOpen}
        />
        <Toaster position="bottom-right" richColors />
      </div>
    </TooltipProvider>
  )
}
