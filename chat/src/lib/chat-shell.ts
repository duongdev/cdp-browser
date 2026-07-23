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
}

export function chatShell(): ChatShellBridge | null {
  return (window as unknown as { chatShell?: ChatShellBridge }).chatShell ?? null
}
