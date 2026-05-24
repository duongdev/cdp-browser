/// <reference types="vite/client" />

interface Pin {
  id: string
  title: string
  url: string
  favicon?: string
  /** Linked remote target id; absent when the pin has no live tab. */
  targetId?: string
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
    syncTheme: boolean
  }>
  setUiState: (
    partial: Partial<{
      sidebarCollapsed: boolean
      pinnedOpen: boolean
      adaptiveViewport: boolean
      forceOnClient: boolean
      switchEffect: "none" | "blur" | "grayscale" | "blur-grayscale"
      notificationsEnabled: boolean
      syncTheme: boolean
    }>,
  ) => Promise<void>
  setThemeSource: (source: "system" | "light" | "dark") => Promise<void>
  getThemeSource: () => Promise<"system" | "light" | "dark">
  onNativeThemeChanged: (cb: (isDark: boolean) => void) => void
  copyToClipboard: (text: string) => Promise<void>
  onSwipe: (cb: (direction: string) => void) => void
  // Pins
  getPins: () => Promise<Pin[]>
  addPin: (pin: Pin) => Promise<Pin[]>
  updatePin: (id: string, patch: { title: string; url: string }) => Promise<Pin[]>
  removePin: (id: string) => Promise<Pin[]>
  reorderPins: (pins: Pin[]) => Promise<Pin[]>
  // Notifications
  getNotifications: () => Promise<CdpNotification[]>
  markNotificationRead: (id: string) => Promise<CdpNotification[]>
  markNotificationUnread: (id: string) => Promise<CdpNotification[]>
  markNotificationsRead: () => Promise<CdpNotification[]>
  clearNotifications: () => Promise<CdpNotification[]>
  onNotification: (cb: (entry: CdpNotification) => void) => void
  onNotificationActivate: (cb: (entry: CdpNotification) => void) => void
}

interface Window {
  cdp: CdpBridge
}
