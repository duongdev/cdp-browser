/// <reference types="vite/client" />

interface Bookmark {
  id: string
  title: string
  url: string
  favicon?: string
}

interface CdpNotification {
  id: string
  source: string
  title: string
  body: string
  targetId: string
  targetUrl?: string
  targetEntity?: unknown
  icon?: string | null
  ts: number
  read: boolean
}

interface CdpBridge {
  listTabs: () => Promise<any>
  newTab: (url?: string) => Promise<any>
  closeTab: (id: string) => Promise<any>
  connect: (id: string) => Promise<any>
  send: (method: string, params?: any) => void
  invoke: (method: string, params?: any) => Promise<any>
  onEvent: (cb: (msg: any) => void) => void
  onDisconnected: (cb: () => void) => void
  getConfig: () => Promise<{ host: string; port: number }>
  setConfig: (config: { host: string; port: number }) => Promise<void>
  testConfig: (config: {
    host: string
    port: number
  }) => Promise<{ ok: true; browser: string } | { error: string }>
  getSidebarWidth: () => Promise<number>
  setSidebarWidth: (width: number) => Promise<void>
  getUiState: () => Promise<{
    sidebarCollapsed: boolean
    pinnedOpen: boolean
    adaptiveViewport: boolean
    forceOnClient: boolean
    switchEffect: "none" | "blur" | "grayscale" | "blur-grayscale"
    notificationsEnabled: boolean
  }>
  setUiState: (
    partial: Partial<{
      sidebarCollapsed: boolean
      pinnedOpen: boolean
      adaptiveViewport: boolean
      forceOnClient: boolean
      switchEffect: "none" | "blur" | "grayscale" | "blur-grayscale"
      notificationsEnabled: boolean
    }>,
  ) => Promise<void>
  setThemeSource: (source: "system" | "light" | "dark") => Promise<void>
  getThemeSource: () => Promise<"system" | "light" | "dark">
  onNativeThemeChanged: (cb: (isDark: boolean) => void) => void
  copyToClipboard: (text: string) => Promise<void>
  onSwipe: (cb: (direction: string) => void) => void
  // Bookmarks
  getBookmarks: () => Promise<Bookmark[]>
  addBookmark: (bookmark: Bookmark) => Promise<Bookmark[]>
  removeBookmark: (url: string) => Promise<Bookmark[]>
  reorderBookmarks: (bookmarks: Bookmark[]) => Promise<Bookmark[]>
  // Notifications
  getNotifications: () => Promise<CdpNotification[]>
  markNotificationRead: (id: string) => Promise<CdpNotification[]>
  markNotificationsRead: () => Promise<CdpNotification[]>
  clearNotifications: () => Promise<CdpNotification[]>
  onNotification: (cb: (entry: CdpNotification) => void) => void
  onNotificationActivate: (cb: (entry: CdpNotification) => void) => void
}

interface Window {
  cdp: CdpBridge
}
