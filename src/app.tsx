import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { EditPinDialog } from "@/components/edit-pin-dialog"
import { NewTabDialog } from "@/components/new-tab-dialog"
import type { NotifEntry } from "@/components/notification-bell"
import type { SwitchEffect } from "@/components/settings-dialog"
import { Sidebar } from "@/components/sidebar"
import { StatusBar } from "@/components/status-bar"
import { Toolbar, type ToolbarHandle } from "@/components/toolbar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Viewport } from "@/components/viewport"
import { useRemotePage } from "@/hooks/use-remote-page"
import { dropDeadLinks, pinForTarget, resolvePinLink } from "@/lib/pins"
import { createClosedTabStack, reconcile, stripTitleBadge, type Tab } from "@/lib/tabs"

export interface TabInfo {
  id: string
  title: string
  url: string
  faviconUrl?: string
  type: string
}

type ThemeSource = "system" | "light" | "dark"

// A keyboard-navigable row in the sidebar — a pin or a visible tab.
type NavRow = { kind: "pin"; pin: Pin } | { kind: "tab"; id: string }

function applyThemeClass(theme: ThemeSource, systemDark: boolean) {
  const isDark = theme === "dark" || (theme === "system" && systemDark)
  document.documentElement.classList.toggle("dark", isDark)
}

// Notifications are attributed to a tab/pin by origin, so every tab of an app
// (e.g. all Teams tabs, pinned or not) shares one unread count.
function originOf(url: string | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).origin
  } catch {
    return null
  }
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
  const [sidebarWidth, setSidebarWidth] = useState(220)
  const uiStateLoadedRef = useRef(false)
  const [theme, setTheme] = useState<ThemeSource>("system")
  const [pins, setPins] = useState<Pin[]>([])
  const [notifications, setNotifications] = useState<NotifEntry[]>([])
  const [notificationsEnabled, setNotificationsEnabled] = useState(true)
  const [syncTheme, setSyncTheme] = useState(true)
  const [bellOpen, setBellOpen] = useState(false)
  const [newTabOpen, setNewTabOpen] = useState(false)
  const [editingPin, setEditingPin] = useState<Pin | null>(null)
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
  const closedTabsRef = useRef(createClosedTabStack())
  const tabsRef = useRef<TabInfo[]>([])
  const activeTabIdRef = useRef<string | null>(null)
  const pinsRef = useRef<Pin[]>([])
  const page = useRemotePage()

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
      uiStateLoadedRef.current = true
    })
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
  // captured it, then deep-opens the message if the adapter supplied a deep-link
  // (Outlook does; Teams keeps a single SPA URL — see docs/adr/0003).
  const handleNotificationClick = useCallback(
    async (entry: NotifEntry) => {
      setBellOpen(false)
      setNotifications((prev) => prev.map((n) => (n.id === entry.id ? { ...n, read: true } : n)))
      window.cdp.markNotificationRead(entry.id)
      await switchTab(entry.targetId)
      const deepLink = (entry.targetEntity as { deepLink?: string } | null)?.deepLink
      if (deepLink) page.navigateSpa(deepLink)
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

  // Unread counts grouped by origin. Every tab/pin of the same app shares the
  // count, whether or not it's the tab that captured the notification.
  const unreadByOrigin = useMemo(() => {
    const m: Record<string, number> = {}
    for (const n of notifications) {
      if (n.read) continue
      const o = originOf(n.targetUrl)
      if (o) m[o] = (m[o] || 0) + 1
    }
    return m
  }, [notifications])

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

  // Per-tab and per-pin unread, resolved through the pin's live tab URL when
  // linked (else its saved URL).
  const unreadByTab = useMemo(() => {
    const m: Record<string, number> = {}
    for (const t of tabs) {
      const o = originOf(t.url)
      m[t.id] = o ? unreadByOrigin[o] || 0 : 0
    }
    return m
  }, [tabs, unreadByOrigin])

  const unreadByPin = useMemo(() => {
    const m: Record<string, number> = {}
    for (const pin of pins) {
      const o = originOf(linkedTabByPin[pin.id]?.url ?? pin.url)
      m[pin.id] = o ? unreadByOrigin[o] || 0 : 0
    }
    return m
  }, [pins, linkedTabByPin, unreadByOrigin])

  const handleNotificationsEnabledChange = useCallback((enabled: boolean) => {
    setNotificationsEnabled(enabled)
    window.cdp.setUiState({ notificationsEnabled: enabled })
  }, [])

  const handleSyncThemeChange = useCallback((enabled: boolean) => {
    setSyncTheme(enabled)
    window.cdp.setUiState({ syncTheme: enabled })
  }, [])

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
      // Save URL for reopen
      const tab = tabsRef.current.find((t) => t.id === tabId)
      if (tab?.url) {
        closedTabsRef.current.push(tab.url)
      }

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
      if (wasActive && ordered && ordered.length > 0) {
        // Prefer a visible tab; fall back to any target (e.g. a pinned one).
        const next = ordered.find((t) => !pinForTarget(pinsRef.current, t.id)) ?? ordered[0]
        await switchTab(next.id)
      }
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

  const reopenClosedTab = useCallback(async () => {
    const lastUrl = closedTabsRef.current.popLast()
    if (lastUrl) {
      await newTab(lastUrl)
    }
  }, [newTab])

  const navigate = useCallback(
    (navUrl: string) => {
      let u = navUrl
      if (!u.match(/^https?:\/\//)) u = `https://${u}`
      setUrl(u)
      page.navigate(u)
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
        if (tab?.url) closedTabsRef.current.push(tab.url)
      }
      tabOrderRef.current = tabOrderRef.current.filter((id) => !ids.includes(id))
      if (closingActive) {
        setActiveTabId(null)
        setLoading(true)
        setLoadingText("No tab selected")
      }
      await Promise.all(ids.map((id) => window.cdp.closeTab(id)))
      await new Promise((r) => setTimeout(r, 300))
      const ordered = await refreshTabs()
      if (closingActive && ordered && ordered.length > 0) {
        const next = ordered.find((t) => !pinForTarget(pinsRef.current, t.id)) ?? ordered[0]
        await switchTab(next.id)
      }
    },
    [refreshTabs, switchTab],
  )

  const goBack = useCallback(() => page.back(), [page])
  const goForward = useCallback(() => page.forward(), [page])
  const reload = useCallback(() => page.reload(), [page])

  const activateRow = useCallback(
    (row: NavRow) => {
      if (row.kind === "pin") activatePin(row.pin)
      else switchTab(row.id)
    },
    [activatePin, switchTab],
  )

  // Cmd+1..9 indexes every pin (top→bottom) then the visible tabs — a number can
  // open a dormant pin.
  const indexRows = useMemo<NavRow[]>(
    () => [
      ...pins.map((p) => ({ kind: "pin" as const, pin: p })),
      ...visibleTabs.map((t) => ({ kind: "tab" as const, id: t.id })),
    ],
    [pins, visibleTabs],
  )

  // Ctrl+Tab cycles only existing views — pins that hold a tab, then visible tabs
  // — so cycling never opens a dormant pin.
  const cycleRows = useMemo<NavRow[]>(
    () => [
      ...pins.filter((p) => p.targetId).map((p) => ({ kind: "pin" as const, pin: p })),
      ...visibleTabs.map((t) => ({ kind: "tab" as const, id: t.id })),
    ],
    [pins, visibleTabs],
  )

  const cycleBy = useCallback(
    (delta: number) => {
      if (cycleRows.length === 0) return
      const cur = cycleRows.findIndex(
        (r) => (r.kind === "pin" ? r.pin.targetId : r.id) === activeTabId,
      )
      const base = cur === -1 ? (delta > 0 ? -1 : 0) : cur
      const next = (base + delta + cycleRows.length) % cycleRows.length
      activateRow(cycleRows[next])
    },
    [cycleRows, activeTabId, activateRow],
  )

  const switchToNextTab = useCallback(() => cycleBy(1), [cycleBy])
  const switchToPrevTab = useCallback(() => cycleBy(-1), [cycleBy])

  // Cmd+1..8 jump to that row; Cmd+9 jumps to the last (browser convention).
  const switchToTabIndex = useCallback(
    (index: number) => {
      const row = index === -1 ? indexRows[indexRows.length - 1] : indexRows[index]
      if (row) activateRow(row)
    },
    [indexRows, activateRow],
  )

  // Keep refs in sync
  useEffect(() => {
    tabsRef.current = tabs
  }, [tabs])
  useEffect(() => {
    pinsRef.current = pins
  }, [pins])
  useEffect(() => {
    activeTabIdRef.current = activeTabId
  }, [activeTabId])

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

      // Cmd+1..9: jump to tab by position (9 = last).
      if (!e.altKey && e.code.startsWith("Digit")) {
        const n = Number(e.code.slice(5))
        if (n >= 1 && n <= 9) {
          e.preventDefault()
          e.stopPropagation()
          switchToTabIndex(n === 9 ? -1 : n - 1)
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
          setNewTabOpen(true)
          break
        case "w":
          e.preventDefault()
          e.stopPropagation()
          if (activeTabId) closeTab(activeTabId)
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

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-screen">
        <Sidebar
          activeTabId={activeTabId}
          collapsed={sidebarCollapsed}
          linkedTabByPin={linkedTabByPin}
          onActivatePin={activatePin}
          onBackToPinnedUrl={backToPinnedUrl}
          onClosePin={(p) => p.targetId && closeTab(p.targetId)}
          onCloseTab={closeTab}
          onCloseTabs={closeTabs}
          onEditPin={setEditingPin}
          onNewTab={() => setNewTabOpen(true)}
          onOpenPinInNewTab={openPinInNewTab}
          onPinnedToggle={() => setPinnedOpen((prev) => !prev)}
          onPinTab={pinTab}
          onReorderPins={persistPins}
          onReorderTabs={reorderTabs}
          onResize={setSidebarWidth}
          onResizeEnd={(w) => window.cdp.setSidebarWidth(w)}
          onSwitchTab={switchTab}
          onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
          onUnpinPin={unpinPin}
          pinnedOpen={pinnedOpen}
          pins={pins}
          tabs={visibleTabs}
          unreadByPin={unreadByPin}
          unreadByTab={unreadByTab}
          width={sidebarWidth}
        />
        <div className="flex flex-1 flex-col min-w-0">
          <Toolbar
            adaptiveViewport={adaptiveViewport}
            bellOpen={bellOpen}
            canGoBack={canGoBack}
            canGoForward={canGoForward}
            emulatedSize={emulatedSize}
            forceOnClient={forceOnClient}
            fps={fps}
            isPinned={activePin != null}
            notifications={notifications}
            notificationsEnabled={notificationsEnabled}
            onAdaptiveViewportChange={handleAdaptiveViewportChange}
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
            onReload={reload}
            onSettingsCommit={handleSettingsCommit}
            onSettingsOpenChange={handleSettingsOpenChange}
            onSettingsRequestOpenMouse={handleSettingsRequestOpenMouse}
            onSwitchEffectChange={handleSwitchEffectChange}
            onSyncThemeChange={handleSyncThemeChange}
            onThemeChange={handleThemeChange}
            onTogglePin={togglePin}
            pageLoading={pageLoading}
            ref={toolbarRef}
            settingsCommitted={settingsCommitted}
            settingsOpen={settingsOpen}
            sidebarCollapsed={sidebarCollapsed}
            status={status}
            switchEffect={switchEffect}
            syncTheme={syncTheme}
            theme={theme}
            url={url}
          />
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
          <StatusBar
            loading={loading}
            loadingText={loadingText}
            onOpenSettings={handleSettingsRequestOpenMouse}
          />
        </div>
        <NewTabDialog
          onActivatePin={activatePin}
          onNewTab={newTab}
          onOpenChange={setNewTabOpen}
          open={newTabOpen}
          pins={pins}
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
      </div>
    </TooltipProvider>
  )
}
