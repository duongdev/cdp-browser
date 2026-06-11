// Push deep-route plumbing (t080, ADR-0012 §6). Pure helpers for landing a push tap in
// the Conversation Reader: the cold-start URL carries only the entry id (`?notif=…`,
// set by the service worker's notificationclick when no window exists); the warm path
// carries the payload entry via postMessage. Either way the store entry wins when
// present — it carries the fields the reader/composer need (channelId, slackKind, …)
// that may be fresher than the push payload. Unknown id → null → the Inbox is home.

import type { ViewEntry } from "./notifications-view"

export function notifIdFromSearch(search: string): string | null {
  const id = new URLSearchParams(search).get("notif")
  return id || null
}

/** The same search string with the one-shot `notif` param consumed. */
export function stripNotifParam(search: string): string {
  const params = new URLSearchParams(search)
  params.delete("notif")
  const rest = params.toString()
  return rest ? `?${rest}` : ""
}

export function resolvePushEntry(
  id: string,
  store: ViewEntry[],
  payload?: ViewEntry,
): ViewEntry | null {
  return store.find((n) => n.id === id) ?? (payload?.id === id ? payload : null)
}
