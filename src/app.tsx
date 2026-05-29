import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { EditPinDialog } from "@/components/edit-pin-dialog"
import { type LocalApi, LocalWebviews } from "@/components/local-webviews"
import { NewTabDialog, type NewTabKind } from "@/components/new-tab-dialog"
import type { NotifEntry } from "@/components/notification-bell"
import type { SwitchEffect } from "@/components/settings-dialog"
import { Sidebar } from "@/components/sidebar"
import { StatusBar } from "@/components/status-bar"
import { Toolbar, type ToolbarHandle } from "@/components/toolbar"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Viewport } from "@/components/viewport"
import { useRemotePage } from "@/hooks/use-remote-page"
import { type ActiveRef, dropActive } from "@/lib/active-order"
import { createClosedStack } from "@/lib/closed-tabs"
import {
  fromPersisted,
  type LocalTab,
  type PersistedLocalTab,
  sortPinnedFirst,
  toPersisted,
} from "@/lib/local-tabs"
import {
  createActivationRegistry,
  deriveLegacyActivate,
  resolveActivation,
} from "@/lib/notification-activation"
import { threadKey } from "@/lib/notifications-view"
import { dropDeadLinks, pinForTarget, resolvePinLink } from "@/lib/pins"
import { planClose, planSwitch } from "@/lib/tab-lifecycle"
import { reconcile, stripTitleBadge, type Tab } from "@/lib/tabs"
import { aggregateUnread } from "@/lib/unread-aggregator"
import { cn } from "@/lib/utils"

type ActiveKind = "cdp" | "local"

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
  const closedTabsRef = useRef(createClosedStack())
  // Most-recently-used activation order across both kinds — on close, fall back
  // to the previous active tab rather than the next in the list.
  const activeOrderRef = useRef<ActiveRef[]>([])
  const tabsRef = useRef<TabInfo[]>([])
  const notificationsRef = useRef<NotifEntry[]>([])
  const activeTabIdRef = useRef<string | null>(null)
  const pinsRef = useRef<Pin[]>([])
  const page = useRemotePage()

  // Local tabs: native WebContentsViews owned by main; we hold the metadata.
  const [localTabs, setLocalTabs] = useState<LocalTab[]>([])
  const [localActiveId, setLocalActiveId] = useState<string | null>(null)
  const [activeKind, setActiveKind] = useState<ActiveKind>("cdp")
  const [autoGrantLocalMedia, setAutoGrantLocalMedia] = useState(true)
  const [localExtensions, setLocalExtensions] = useState<LocalExtensionInfo[]>([])
  const localTabsRef = useRef<LocalTab[]>([])
  const localActiveIdRef = useRef<string | null>(null)
  const activeKindRef = useRef<ActiveKind>("cdp")
  const restoreLocalPinsRef = useRef(true)
  const localRestoredRef = useRef(false)
  // Late-bound so the one-time onOpenUrl listener always calls the latest impl.
  const createLocalTabRef = useRef<((url?: string) => Promise<string>) | null>(null)
  // Imperative nav controls for the active local <webview>, set by LocalWebviews.
  const localApiRef = useRef<LocalApi | null>(null)
  // switchLocalTab is defined below closeTab/closeTabs, which need it for MRU fallback.
  const switchLocalTabRef = useRef<((id: string) => void) | null>(null)
  const activeLocalTab = useMemo(
    () => localTabs.find((t) => t.id === localActiveId) ?? null,
    [localTabs, localActiveId],
  )

  // Theme initialization
  useEffect(() => {
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
      // from their persisted urls.
      if (!localRestoredRef.current && (s.restoreLocalPins ?? true)) {
        localRestoredRef.current = true
        window.local.getPins().then((saved: PersistedLocalTab[]) => {
          const restored = sortPinnedFirst(fromPersisted(saved))
          localTabsRef.current = restored
          setLocalTabs(restored)
        })
      }
    })
    window.local.getExtensions().then(setLocalExtensions)
    window.cdp.getNotifications().then(setNotifications)
    window.cdp.onNotification((entry) => {
      setNotifications((prev) => (prev.some((n) => n.id === entry.id) ? prev : [entry, ...prev]))
    })
  }, [])

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
      setActiveKind("cdp")
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
    [updateNavHistory],
  )

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
      const key = threadKey(entry)
      const siblings = notificationsRef.current.filter(
        (n) => n.id !== entry.id && !n.read && threadKey(n) === key,
      )
      setNotifications((prev) => prev.map((n) => (threadKey(n) === key ? { ...n, read: true } : n)))
      window.cdp.markNotificationRead(entry.id)
      for (const n of siblings) window.cdp.markNotificationRead(n.id)
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
    [switchTab, page],
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
      else if (directive.nextActive?.kind === "local")
        switchLocalTabRef.current?.(directive.nextActive.id)
    },
    [refreshTabs, switchTab],
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

  // --- Local tabs ---

  // All open local tabs are saved on every list change (restored on launch).
  const persistLocalPins = useCallback((next: LocalTab[]) => {
    window.local.savePins(toPersisted(next) as PersistedLocalTab[])
  }, [])

  const setLocalTabsAnd = useCallback(
    (updater: (prev: LocalTab[]) => LocalTab[]) => {
      setLocalTabs((prev) => {
        const next = sortPinnedFirst(updater(prev))
        localTabsRef.current = next
        persistLocalPins(next)
        return next
      })
    },
    [persistLocalPins],
  )

  const switchLocalTab = useCallback((id: string) => {
    setActiveKind("local")
    activeOrderRef.current = planSwitch(activeOrderRef.current, { kind: "local", id })
    setLocalActiveId(id)
  }, [])
  useEffect(() => {
    switchLocalTabRef.current = switchLocalTab
  }, [switchLocalTab])

  const createLocalTab = useCallback(
    async (rawUrl?: string, opts?: { pinned?: boolean }) => {
      let u = rawUrl || "https://www.google.com"
      // Only assume https for a bare domain — keep real schemes (chrome-extension://, etc.).
      if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = `https://${u}`
      const id = crypto.randomUUID()
      const tab: LocalTab = {
        id,
        url: u,
        title: u,
        pinned: opts?.pinned ?? false,
        loading: true,
        canGoBack: false,
        canGoForward: false,
        audible: false,
        muted: false,
      }
      setLocalTabsAnd((prev) => [...prev, tab])
      switchLocalTab(id)
      return id
    },
    [setLocalTabsAnd, switchLocalTab],
  )

  const closeLocalTab = useCallback(
    (id: string) => {
      const tab = localTabsRef.current.find((t) => t.id === id)
      const wasActive = localActiveIdRef.current === id
      const remaining = localTabsRef.current.filter((t) => t.id !== id)
      setLocalTabsAnd(() => remaining)
      const directive = planClose({
        kind: "local",
        id,
        url: tab?.url ?? "",
        wasActive,
        order: activeOrderRef.current,
        tabs: tabsRef.current.filter((t) => !pinForTarget(pinsRef.current, t.id)),
        locals: remaining,
        pins: pinsRef.current,
      })
      if (tab?.url) closedTabsRef.current.push(directive.closedEntry)
      activeOrderRef.current = dropActive(activeOrderRef.current, { kind: "local", id })
      if (wasActive) {
        if (directive.nextActive?.kind === "local") switchLocalTab(directive.nextActive.id)
        else if (directive.nextActive?.kind === "cdp") switchTab(directive.nextActive.id)
        else if (directive.clearActive) {
          setLocalActiveId(null)
          setActiveKind("cdp")
        }
      }
    },
    [setLocalTabsAnd, switchLocalTab, switchTab],
  )

  // Apply a live update from a webview event (title/favicon/loading/nav/audio).
  const patchLocalTab = useCallback((id: string, patch: Partial<LocalTab>) => {
    setLocalTabs((prev) => {
      const next = prev.map((t) => (t.id === id ? { ...t, ...patch } : t))
      localTabsRef.current = next
      return next
    })
  }, [])

  const toggleLocalPin = useCallback(
    (id: string) => {
      setLocalTabsAnd((prev) => prev.map((t) => (t.id === id ? { ...t, pinned: !t.pinned } : t)))
    },
    [setLocalTabsAnd],
  )

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

  const reorderLocalTabs = useCallback(
    (reordered: LocalTab[]) => setLocalTabsAnd(() => reordered),
    [setLocalTabsAnd],
  )

  const handleEditLocalSave = useCallback(
    (id: string, title: string, nextUrl: string) => {
      const current = localTabsRef.current.find((t) => t.id === id)
      setLocalTabsAnd((prev) => prev.map((t) => (t.id === id ? { ...t, title, url: nextUrl } : t)))
      if (current && current.url !== nextUrl) localApiRef.current?.navigate(id, nextUrl)
    },
    [setLocalTabsAnd],
  )

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
        else if (directive.nextActive?.kind === "local")
          switchLocalTabRef.current?.(directive.nextActive.id)
      }
    },
    [refreshTabs, switchTab],
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
  useEffect(() => {
    localActiveIdRef.current = localActiveId
  }, [localActiveId])
  useEffect(() => {
    createLocalTabRef.current = createLocalTab
  }, [createLocalTab])
  useEffect(() => {
    activeKindRef.current = activeKind
  }, [activeKind])

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
          setStatus("Disconnected")
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

      // Cmd+Shift+T: reopen closed tab. macOS reports e.key lowercase even with
      // Shift while Cmd is held, so compare case-insensitively.
      if (e.shiftKey && e.key.toLowerCase() === "t") {
        e.preventDefault()
        e.stopPropagation()
        reopenClosedTab()
        return
      }

      // Cmd+Alt combos
      if (e.altKey) {
        switch (e.key) {
          case "l": // Cmd+Opt+L: copy URL
          case "L":
            e.preventDefault()
            e.stopPropagation()
            if (url) window.cdp.copyToClipboard(url)
            return
        }
      }

      switch (e.key) {
        case "t":
          e.preventDefault()
          e.stopPropagation()
          openNewTab(activeKindRef.current)
          break
        case "w":
          e.preventDefault()
          e.stopPropagation()
          if (activeKindRef.current === "local") {
            const id = localActiveIdRef.current
            // A pinned local tab is a persistent pin — Cmd+W must not destroy it
            // (mirrors CDP pins, where Cmd+W closes the tab but keeps the holder).
            const pinned = localTabsRef.current.find((t) => t.id === id)?.pinned
            if (id && !pinned) closeLocalTab(id)
          } else if (activeTabId) {
            closeTab(activeTabId)
          }
          break
        case "d":
          e.preventDefault()
          e.stopPropagation()
          togglePin()
          break
        case "l":
          e.preventDefault()
          e.stopPropagation()
          toolbarRef.current?.focusUrlBar()
          break
        case "s":
          e.preventDefault()
          e.stopPropagation()
          setSidebarCollapsed((prev) => !prev)
          break
        case ",": {
          e.preventDefault()
          e.stopPropagation()
          const next = !settingsOpenRef.current
          setSettingsOpen(next)
          setSettingsCommitted(next) // keyboard-opened drawers start committed
          break
        }
        case "r":
          e.preventDefault()
          e.stopPropagation()
          reload()
          break
        case "[":
          e.preventDefault()
          e.stopPropagation()
          goBack()
          break
        case "]":
          e.preventDefault()
          e.stopPropagation()
          goForward()
          break
        case "f":
          e.preventDefault()
          e.stopPropagation()
          window.cdp.send("Runtime.evaluate", {
            expression: "window.find(prompt('Find in page:') || '')",
          })
          break
        case "c": {
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
        case "a": {
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
    activeTabId,
    closeTab,
    closeLocalTab,
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
  ])

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

  // Local pinned tabs surfaced as quick-launch entries in the local New-tab dialog.
  const localQuickLaunch = useMemo<Pin[]>(
    () =>
      localTabs
        .filter((t) => t.pinned)
        .map((t) => ({ id: t.id, title: t.title, url: t.url, favicon: t.favicon })),
    [localTabs],
  )

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-full">
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
          onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
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
        <div className="flex flex-1 flex-col min-w-0">
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
            onNavigate={navigate}
            onNotificationClick={handleNotificationClick}
            onNotificationsEnabledChange={handleNotificationsEnabledChange}
            onNotificationToggleRead={handleToggleRead}
            onOpenActionPopup={handleOpenActionPopup}
            onOpenExtensionUrl={handleOpenExtensionUrl}
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
            </div>
            {/* Local tabs as live <webview>s — React overlays stack above via
                z-index, so no freeze/snapshot is needed. */}
            <LocalWebviews
              activeId={localActiveId}
              apiRef={localApiRef}
              onOpenUrl={(u) => createLocalTab(u)}
              onPatch={patchLocalTab}
              tabs={localTabs}
              visible={isLocal}
            />
          </div>
          <StatusBar
            loading={loading}
            loadingText={loadingText}
            onOpenSettings={handleSettingsRequestOpenMouse}
          />
        </div>
        <NewTabDialog
          cdpPins={pins}
          initialKind={newTabKind}
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
        <Toaster position="bottom-right" richColors />
      </div>
    </TooltipProvider>
  )
}
