import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { AddBookmarkDialog } from "@/components/add-bookmark-dialog"
import { NewTabDialog } from "@/components/new-tab-dialog"
import type { NotifEntry } from "@/components/notification-bell"
import type { SwitchEffect } from "@/components/settings-dialog"
import { Sidebar } from "@/components/sidebar"
import { StatusBar } from "@/components/status-bar"
import { Toolbar, type ToolbarHandle } from "@/components/toolbar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Viewport } from "@/components/viewport"
import { useRemotePage } from "@/hooks/use-remote-page"
import {
  createClosedTabStack,
  nextTab,
  prevTab,
  reconcile,
  stripTitleBadge,
  type Tab,
} from "@/lib/tabs"

export interface TabInfo {
  id: string
  title: string
  url: string
  faviconUrl?: string
  type: string
}

type ThemeSource = "system" | "light" | "dark"

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
  const [sidebarWidth, setSidebarWidth] = useState(220)
  const uiStateLoadedRef = useRef(false)
  const [theme, setTheme] = useState<ThemeSource>("system")
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([])
  const [notifications, setNotifications] = useState<NotifEntry[]>([])
  const [notificationsEnabled, setNotificationsEnabled] = useState(true)
  const [syncTheme, setSyncTheme] = useState(true)
  const [bellOpen, setBellOpen] = useState(false)
  const [newTabOpen, setNewTabOpen] = useState(false)
  const [addBookmarkOpen, setAddBookmarkOpen] = useState(false)
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

  // Load bookmarks + persisted sidebar width + UI state
  useEffect(() => {
    window.cdp.getBookmarks().then(setBookmarks)
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

  const addBookmark = useCallback(async (title: string, bookmarkUrl: string, favicon?: string) => {
    const id = crypto.randomUUID()
    const updated = await window.cdp.addBookmark({
      id,
      title,
      url: bookmarkUrl,
      favicon,
    })
    setBookmarks(updated)
  }, [])

  const removeBookmark = useCallback(async (bookmarkUrl: string) => {
    const updated = await window.cdp.removeBookmark(bookmarkUrl)
    setBookmarks(updated)
  }, [])

  const handleBookmarkClick = useCallback(() => {
    if (!url) return
    const existing = bookmarks.find((b) => b.url === url)
    if (existing) {
      removeBookmark(url)
    } else {
      setAddBookmarkOpen(true)
    }
  }, [url, bookmarks, removeBookmark])

  const handleSaveBookmark = useCallback(
    (title: string, bookmarkUrl: string) => {
      const activeTab = tabs.find((t) => t.id === activeTabId)
      addBookmark(title, bookmarkUrl, activeTab?.faviconUrl)
    },
    [tabs, activeTabId, addBookmark],
  )

  const reorderBookmarks = useCallback(async (reordered: Bookmark[]) => {
    setBookmarks(reordered)
    await window.cdp.reorderBookmarks(reordered)
  }, [])

  const reorderTabs = useCallback((reordered: TabInfo[]) => {
    tabOrderRef.current = reordered.map((t) => t.id)
    setTabs(reordered)
  }, [])

  const isCurrentUrlBookmarked = bookmarks.some((b) => b.url === url)

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
  // captured it. v1 stops at activation; deep-conversation open is deferred (no
  // verified navigation target — see docs/adr/0003).
  const handleNotificationClick = useCallback(
    (entry: NotifEntry) => {
      setBellOpen(false)
      setNotifications((prev) => prev.map((n) => (n.id === entry.id ? { ...n, read: true } : n)))
      window.cdp.markNotificationRead(entry.id)
      switchTab(entry.targetId)
    },
    [switchTab],
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

  // Keyed by CDP target id (== tab id), for the sidebar badge.
  const unreadByTab = useMemo(() => {
    const m: Record<string, number> = {}
    for (const n of notifications) if (!n.read) m[n.targetId] = (m[n.targetId] || 0) + 1
    return m
  }, [notifications])

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
        await switchTab(ordered[0].id)
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

  const goBack = useCallback(() => page.back(), [page])
  const goForward = useCallback(() => page.forward(), [page])
  const reload = useCallback(() => page.reload(), [page])

  const switchToNextTab = useCallback(() => {
    if (tabs.length === 0) return
    switchTab(nextTab(tabs, activeTabId))
  }, [tabs, activeTabId, switchTab])

  const switchToPrevTab = useCallback(() => {
    if (tabs.length === 0) return
    switchTab(prevTab(tabs, activeTabId))
  }, [tabs, activeTabId, switchTab])

  // Cmd+1..8 jump to that tab; Cmd+9 jumps to the last (browser convention).
  const switchToTabIndex = useCallback(
    (index: number) => {
      const target = index === -1 ? tabs[tabs.length - 1] : tabs[index]
      if (target) switchTab(target.id)
    },
    [tabs, switchTab],
  )

  // Keep refs in sync
  useEffect(() => {
    tabsRef.current = tabs
  }, [tabs])
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
          handleBookmarkClick()
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
    handleBookmarkClick,
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

  // Initial load + refresh interval
  useEffect(() => {
    refreshTabs().then((ordered) => {
      if (ordered && ordered.length > 0) switchTab(ordered[0].id)
    })
    const interval = setInterval(refreshTabs, 3000)
    return () => clearInterval(interval)
  }, [refreshTabs, switchTab])

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-screen">
        <Sidebar
          activeTabId={activeTabId}
          bookmarks={bookmarks}
          collapsed={sidebarCollapsed}
          onCloseTab={closeTab}
          onNavigateBookmark={navigate}
          onNewTab={() => setNewTabOpen(true)}
          onOpenBookmarkInNewTab={newTab}
          onPinnedToggle={() => setPinnedOpen((prev) => !prev)}
          onRemoveBookmark={removeBookmark}
          onReorderBookmarks={reorderBookmarks}
          onReorderTabs={reorderTabs}
          onResize={setSidebarWidth}
          onResizeEnd={(w) => window.cdp.setSidebarWidth(w)}
          onSwitchTab={switchTab}
          onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
          pinnedOpen={pinnedOpen}
          tabs={tabs}
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
            isBookmarked={isCurrentUrlBookmarked}
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
            onReload={reload}
            onSettingsCommit={handleSettingsCommit}
            onSettingsOpenChange={handleSettingsOpenChange}
            onSettingsRequestOpenMouse={handleSettingsRequestOpenMouse}
            onSwitchEffectChange={handleSwitchEffectChange}
            onSyncThemeChange={handleSyncThemeChange}
            onThemeChange={handleThemeChange}
            onToggleBookmark={handleBookmarkClick}
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
          bookmarks={bookmarks}
          onNewTab={newTab}
          onOpenChange={setNewTabOpen}
          open={newTabOpen}
        />
        <AddBookmarkDialog
          defaultTitle={tabs.find((t) => t.id === activeTabId)?.title || url}
          defaultUrl={url}
          onOpenChange={setAddBookmarkOpen}
          onSave={handleSaveBookmark}
          open={addBookmarkOpen}
        />
      </div>
    </TooltipProvider>
  )
}
