import { useState, useEffect, useCallback, useRef } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Sidebar } from "@/components/Sidebar";
import { Toolbar, type ToolbarHandle } from "@/components/Toolbar";
import { Viewport } from "@/components/Viewport";
import { NewTabDialog } from "@/components/NewTabDialog";
import { AddBookmarkDialog } from "@/components/AddBookmarkDialog";

export interface TabInfo {
  id: string;
  title: string;
  url: string;
  faviconUrl?: string;
  type: string;
}

type ThemeSource = "system" | "light" | "dark";

function applyThemeClass(theme: ThemeSource, systemDark: boolean) {
  const isDark = theme === "dark" || (theme === "system" && systemDark);
  document.documentElement.classList.toggle("dark", isDark);
}

export default function App() {
  const [tabs, setTabs] = useState<TabInfo[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState("Disconnected");
  const [fps, setFps] = useState("");
  const [resolution, setResolution] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingText, setLoadingText] = useState("Connecting...");
  const [pageLoading, setPageLoading] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [theme, setTheme] = useState<ThemeSource>("system");
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [newTabOpen, setNewTabOpen] = useState(false);
  const [addBookmarkOpen, setAddBookmarkOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const tabOrderRef = useRef<string[]>([]);
  const systemDarkRef = useRef(true);
  const toolbarRef = useRef<ToolbarHandle>(null);
  const closedTabsRef = useRef<string[]>([]);

  // Theme initialization
  useEffect(() => {
    window.cdp.getThemeSource().then((source) => {
      setTheme(source);
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      systemDarkRef.current = mq.matches;
      applyThemeClass(source, mq.matches);
    });

    window.cdp.onNativeThemeChanged((isDark) => {
      systemDarkRef.current = isDark;
      setTheme((prev) => {
        applyThemeClass(prev, isDark);
        return prev;
      });
    });
  }, []);

  // Load bookmarks
  useEffect(() => {
    window.cdp.getBookmarks().then(setBookmarks);
  }, []);

  const handleThemeChange = useCallback((newTheme: ThemeSource) => {
    setTheme(newTheme);
    applyThemeClass(newTheme, systemDarkRef.current);
    window.cdp.setThemeSource(newTheme);
  }, []);

  const addBookmark = useCallback(
    async (title: string, bookmarkUrl: string, favicon?: string) => {
      const id = crypto.randomUUID();
      const updated = await window.cdp.addBookmark({
        id,
        title,
        url: bookmarkUrl,
        favicon,
      });
      setBookmarks(updated);
    },
    []
  );

  const removeBookmark = useCallback(async (bookmarkUrl: string) => {
    const updated = await window.cdp.removeBookmark(bookmarkUrl);
    setBookmarks(updated);
  }, []);

  const handleBookmarkClick = useCallback(() => {
    if (!url) return;
    const existing = bookmarks.find((b) => b.url === url);
    if (existing) {
      removeBookmark(url);
    } else {
      setAddBookmarkOpen(true);
    }
  }, [url, bookmarks, removeBookmark]);

  const handleSaveBookmark = useCallback(
    (title: string, bookmarkUrl: string) => {
      const activeTab = tabs.find((t) => t.id === activeTabId);
      addBookmark(title, bookmarkUrl, activeTab?.faviconUrl);
    },
    [tabs, activeTabId, addBookmark]
  );

  const reorderBookmarks = useCallback(async (reordered: Bookmark[]) => {
    setBookmarks(reordered);
    await window.cdp.reorderBookmarks(reordered);
  }, []);

  const reorderTabs = useCallback((reordered: TabInfo[]) => {
    tabOrderRef.current = reordered.map((t) => t.id);
    setTabs(reordered);
  }, []);

  const isCurrentUrlBookmarked = bookmarks.some((b) => b.url === url);

  const updateNavHistory = useCallback(async () => {
    const result = await window.cdp.invoke("Page.getNavigationHistory");
    if (result && !result.error && result.entries) {
      setCanGoBack(result.currentIndex > 0);
      setCanGoForward(result.currentIndex < result.entries.length - 1);
    }
  }, []);

  const refreshTabs = useCallback(async () => {
    const result = await window.cdp.listTabs();
    if (result.error) {
      setStatus("Error: " + result.error);
      return;
    }
    const pages = result.filter((t: any) => t.type === "page");
    const newIds = pages.map((t: any) => t.id);
    tabOrderRef.current = tabOrderRef.current.filter((id) =>
      newIds.includes(id)
    );
    for (const id of newIds) {
      if (!tabOrderRef.current.includes(id)) tabOrderRef.current.push(id);
    }
    const ordered = tabOrderRef.current
      .map((id) => pages.find((t: any) => t.id === id))
      .filter(Boolean);
    setTabs(ordered);
    return ordered;
  }, []);

  const switchTab = useCallback(async (tabId: string) => {
    setActiveTabId(tabId);
    setLoading(true);
    setLoadingText("Connecting...");
    setStatus("Connecting...");

    const result = await window.cdp.connect(tabId);
    if (result.error && result.error !== "cancelled") {
      setStatus("Error: " + result.error);
      setLoadingText("Error: " + result.error);
    } else {
      updateNavHistory();
    }
  }, [updateNavHistory]);

  const newTab = useCallback(
    async (tabUrl?: string) => {
      const result = await window.cdp.newTab(
        tabUrl || "https://www.google.com"
      );
      if (!result.error) {
        await refreshTabs();
        await switchTab(result.id);
      }
    },
    [refreshTabs, switchTab]
  );

  const closeTab = useCallback(
    async (tabId: string) => {
      // Save URL for reopen
      const tab = tabs.find((t) => t.id === tabId);
      if (tab?.url) {
        closedTabsRef.current.push(tab.url);
      }

      await window.cdp.closeTab(tabId);
      if (tabId === activeTabId) {
        setActiveTabId(null);
        setLoading(true);
        setLoadingText("No tab selected");
      }
      const ordered = await refreshTabs();
      if (tabId === activeTabId && ordered && ordered.length > 0) {
        await switchTab(ordered[0].id);
      }
    },
    [activeTabId, refreshTabs, switchTab, tabs]
  );

  const reopenClosedTab = useCallback(async () => {
    const lastUrl = closedTabsRef.current.pop();
    if (lastUrl) {
      await newTab(lastUrl);
    }
  }, [newTab]);

  const navigate = useCallback((navUrl: string) => {
    let u = navUrl;
    if (!u.match(/^https?:\/\//)) u = "https://" + u;
    setUrl(u);
    window.cdp.send("Page.navigate", { url: u });
  }, []);

  const goBack = useCallback(() => {
    window.cdp.send("Runtime.evaluate", { expression: "history.back()" });
  }, []);

  const goForward = useCallback(() => {
    window.cdp.send("Runtime.evaluate", { expression: "history.forward()" });
  }, []);

  const reload = useCallback(() => {
    window.cdp.send("Page.reload");
  }, []);

  const switchToNextTab = useCallback(() => {
    if (tabs.length === 0) return;
    const idx = tabs.findIndex((t) => t.id === activeTabId);
    const next = (idx + 1) % tabs.length;
    switchTab(tabs[next].id);
  }, [tabs, activeTabId, switchTab]);

  const switchToPrevTab = useCallback(() => {
    if (tabs.length === 0) return;
    const idx = tabs.findIndex((t) => t.id === activeTabId);
    const prev = (idx - 1 + tabs.length) % tabs.length;
    switchTab(tabs[prev].id);
  }, [tabs, activeTabId, switchTab]);

  // Update URL when active tab changes
  useEffect(() => {
    const tab = tabs.find((t) => t.id === activeTabId);
    if (tab) setUrl(tab.url || "");
  }, [activeTabId, tabs]);

  // CDP events
  useEffect(() => {
    window.cdp.onEvent((msg: any) => {
      if (msg.method === "Page.screencastFrame") {
        setLoading(false);
        setStatus("Connected");
      }
      if (msg.method === "Page.frameNavigated") {
        const frameUrl = msg.params?.frame?.url;
        if (frameUrl) setUrl(frameUrl);
        refreshTabs();
        updateNavHistory();
      }
      // Page loading state
      if (msg.method === "Page.frameStartedLoading") {
        setPageLoading(true);
      }
      if (msg.method === "Page.frameStoppedLoading" || msg.method === "Page.loadEventFired") {
        setPageLoading(false);
      }
    });

    window.cdp.onDisconnected(() => {
      setStatus("Disconnected");
    });
  }, [refreshTabs, updateNavHistory]);

  // Trackpad swipe gestures
  useEffect(() => {
    window.cdp.onSwipe((direction) => {
      if (direction === "left") goBack();
      if (direction === "right") goForward();
    });
  }, [goBack, goForward]);

  // Global hotkeys (capture phase to intercept before CDP forwarding)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+Tab / Ctrl+Shift+Tab: switch tabs
      if (e.ctrlKey && e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) {
          switchToPrevTab();
        } else {
          switchToNextTab();
        }
        return;
      }

      if (!e.metaKey) return;

      // Cmd+Shift combos
      if (e.shiftKey) {
        switch (e.key) {
          case "T": // Cmd+Shift+T: reopen closed tab
            e.preventDefault();
            e.stopPropagation();
            reopenClosedTab();
            return;
        }
      }

      // Cmd+Alt combos
      if (e.altKey) {
        switch (e.key) {
          case "l": // Cmd+Opt+L: copy URL
          case "L":
            e.preventDefault();
            e.stopPropagation();
            if (url) window.cdp.copyToClipboard(url);
            return;
        }
      }

      switch (e.key) {
        case "t":
          e.preventDefault();
          e.stopPropagation();
          setNewTabOpen(true);
          break;
        case "w":
          e.preventDefault();
          e.stopPropagation();
          if (activeTabId) closeTab(activeTabId);
          break;
        case "d":
          e.preventDefault();
          e.stopPropagation();
          handleBookmarkClick();
          break;
        case "l":
          e.preventDefault();
          e.stopPropagation();
          toolbarRef.current?.focusUrlBar();
          break;
        case "s":
          e.preventDefault();
          e.stopPropagation();
          setSidebarCollapsed((prev) => !prev);
          break;
        case ",":
          e.preventDefault();
          e.stopPropagation();
          setSettingsOpen(true);
          break;
        case "r":
          e.preventDefault();
          e.stopPropagation();
          reload();
          break;
        case "[":
          e.preventDefault();
          e.stopPropagation();
          goBack();
          break;
        case "]":
          e.preventDefault();
          e.stopPropagation();
          goForward();
          break;
        case "f":
          e.preventDefault();
          e.stopPropagation();
          window.cdp.send("Runtime.evaluate", {
            expression: "window.find(prompt('Find in page:') || '')",
          });
          break;
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
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
    url,
  ]);

  // Initial load + refresh interval
  useEffect(() => {
    refreshTabs().then((ordered) => {
      if (ordered && ordered.length > 0) switchTab(ordered[0].id);
    });
    const interval = setInterval(refreshTabs, 3000);
    return () => clearInterval(interval);
  }, [refreshTabs, switchTab]);

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-screen">
        <Sidebar
          tabs={tabs}
          activeTabId={activeTabId}
          onSwitchTab={switchTab}
          onCloseTab={closeTab}
          onNewTab={() => setNewTabOpen(true)}
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
          bookmarks={bookmarks}
          onNavigateBookmark={navigate}
          onOpenBookmarkInNewTab={newTab}
          onRemoveBookmark={removeBookmark}
          onReorderBookmarks={reorderBookmarks}
          onReorderTabs={reorderTabs}
        />
        <div className="flex flex-1 flex-col min-w-0">
          <Toolbar
            ref={toolbarRef}
            url={url}
            sidebarCollapsed={sidebarCollapsed}
            onNavigate={navigate}
            onBack={goBack}
            onForward={goForward}
            onReload={reload}
            canGoBack={canGoBack}
            canGoForward={canGoForward}
            pageLoading={pageLoading}
            status={status}
            fps={fps}
            resolution={resolution}
            theme={theme}
            onThemeChange={handleThemeChange}
            isBookmarked={isCurrentUrlBookmarked}
            onToggleBookmark={handleBookmarkClick}
            settingsOpen={settingsOpen}
            onSettingsOpenChange={setSettingsOpen}
          />
          <Viewport
            loading={loading}
            loadingText={loadingText}
            onFpsUpdate={setFps}
            onResolutionUpdate={setResolution}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        </div>
        <NewTabDialog
          open={newTabOpen}
          onOpenChange={setNewTabOpen}
          bookmarks={bookmarks}
          onNewTab={newTab}
        />
        <AddBookmarkDialog
          open={addBookmarkOpen}
          onOpenChange={setAddBookmarkOpen}
          defaultTitle={tabs.find((t) => t.id === activeTabId)?.title || url}
          defaultUrl={url}
          onSave={handleSaveBookmark}
        />
      </div>
    </TooltipProvider>
  );
}
