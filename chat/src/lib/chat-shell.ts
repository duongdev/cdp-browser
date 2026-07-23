// Bridge to the standalone Electron chat shell (chat-preload.js). When the chat
// renderer runs inside the "CDP Chats" Electron app, `window.chatShell` exists
// and notifications + the dock badge go through the native main process — the
// same mechanism as the CDP Browser app (main-process `Notification` + dock
// badge), instead of the web `Notification`/Web-Push path. On the plain web
// build this returns null and callers fall back to the web path.
export interface ChatShellBridge {
  notify(p: { title: string; body: string; convId: string }): void
  setBadge(count: number): void
  onNotificationActivate(cb: (convId: string) => void): void
  /** Browser-style nav for the Electron window: back/forward walk the page history; reload does a
   *  cache-bypassing reload (force-fetches a new build). */
  goBack(): void
  goForward(): void
  reload(): void
  /** The server the shell loads /chat from — editable in Settings (Electron-only). Setting it
   *  persists to chat-config.json and reloads the window to the new server. */
  getServerUrl(): Promise<string>
  setServerUrl(url: string): void
  /** Persist the current SPA path so the next launch reopens the last conversation. */
  routeChanged(path: string): void
}

export function chatShell(): ChatShellBridge | null {
  return (window as unknown as { chatShell?: ChatShellBridge }).chatShell ?? null
}
