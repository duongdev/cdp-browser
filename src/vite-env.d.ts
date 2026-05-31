/// <reference types="vite/client" />

// Build identity injected by Vite define (vite.config.ts): the package.json version
// and the short git SHA at build time. __GIT_SHA__ is "unknown" outside a checkout.
declare const __APP_VERSION__: string
declare const __GIT_SHA__: string

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
  adapter?: string | null
  groupKey?: string
  activate?: import("./lib/notification-activation").ActivateIntent | null
  icon?: string | null
  ts: number
  read: boolean
}

interface CdpBridge {
  listTabs: () => Promise<any>
  newTab: (url?: string) => Promise<any>
  closeTab: (id: string) => Promise<any>
  connect: (id: string) => Promise<any>
  // Manual force-reconnect (web build only, t042). Cancels any pending backoff timer, resets
  // the schedule to base, and re-enters connect() for the last tab through t040's driver +
  // generation guard. Electron's preload doesn't implement it — the UI guards with `?.`.
  reconnect?: () => void
  send: (method: string, params?: any) => void
  // Ack a Screencast Frame *after* the renderer has painted it (web build only, t056). On
  // the WS paint-ack path the server defers its own remote-ack and gates the next frame on
  // this, capping the in-flight queue at one so a slow link can't accrue a stale-frame
  // backlog. Electron's preload doesn't implement it (the renderer's remote-page auto-acks
  // on handle) — the viewport guards with `?.`. A no-op on the SSE path (server self-acks).
  ackPaintedFrame?: (sessionId: number) => void
  invoke: (method: string, params?: any) => Promise<any>
  onEvent: (cb: (msg: any) => void) => void
  // The phase is web-only (auto-reconnect, t040): "reconnecting" while the backoff loop
  // retries, "lost" once it gives up. Electron passes no arg → treated as a terminal loss.
  onDisconnected: (cb: (phase?: "reconnecting" | "lost") => void) => void
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
    autoGrantLocalMedia: boolean
    restoreLocalPins: boolean
    localExtensionPaths: string[]
    webPush: boolean
    qualityTier: "sharp" | "balanced" | "snappy"
    virtualPointerMode: "off" | "on" | "auto"
    settingsScrollTop: number
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
      autoGrantLocalMedia: boolean
      restoreLocalPins: boolean
      webPush: boolean
      qualityTier: "sharp" | "balanced" | "snappy"
      virtualPointerMode: "off" | "on" | "auto"
      settingsScrollTop: number
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
  // Web Push (web build only — Electron has its own Notification API).
  // `getPushVapidKey` returns the server's VAPID public key for pushManager.subscribe.
  // `subscribePush`/`unsubscribePush` POST the browser-issued subscription to the server.
  getPushVapidKey?: () => Promise<string>
  subscribePush?: (subscription: PushSubscriptionJSON) => Promise<void>
  unsubscribePush?: (endpoint: string) => Promise<void>
  // Input transport picker (web build only — Electron uses IPC, no transport choice).
  // The settings UI calls reconfigureInputTransport() after writing the pref to
  // localStorage; the active-mode badge reads getActiveTransport() and subscribes via
  // onActiveTransportChange(). See ADR-0007.
  reconfigureInputTransport?: () => void
  getActiveTransport?: () => "auto" | "ws" | "stream" | "batch"
  onActiveTransportChange?: (cb: (mode: "auto" | "ws" | "stream" | "batch") => void) => void
}

interface PersistedLocalTabBridge {
  id: string
  url: string
  title: string
  favicon?: string
  pinned: boolean
}

// Local tabs render as <webview> in the renderer DOM; main only owns the
// session, permissions, extensions, and the action-popup popover.
interface LocalBridge {
  getPins: () => Promise<PersistedLocalTabBridge[]>
  savePins: (pins: PersistedLocalTabBridge[]) => Promise<void>
  getExtensions: () => Promise<LocalExtensionInfo[]>
  pickExtension: () => Promise<ExtResult>
  reloadExtension: (path: string) => Promise<ExtResult>
  removeExtension: (path: string) => Promise<ExtResult>
  openActionPopup: (id: string, anchor: { right: number; bottom: number }) => Promise<void>
  closeActionPopup: () => Promise<void>
}

interface LocalExtensionInfo {
  path: string
  loaded: boolean
  id: string | null
  name: string
  version: string
  description: string
  icon: string | null
  popupUrl: string | null
  optionsUrl: string | null
}

type ExtResult = { extensions: LocalExtensionInfo[] } | { error: string }

interface Window {
  cdp: CdpBridge
  local: LocalBridge
  /** Present only in the web build; absent under Electron. See cdp-web-transport.ts. */
  webCaps?: { web: boolean; localTabs: boolean; extensions: boolean }
}

// Electron <webview> tag (webviewTag enabled on the chrome view).
declare namespace JSX {
  interface IntrinsicElements {
    webview: React.DetailedHTMLProps<
      React.HTMLAttributes<HTMLElement> & {
        src?: string
        partition?: string
        allowpopups?: boolean
        preload?: string
        useragent?: string
      },
      HTMLElement
    >
  }
}
