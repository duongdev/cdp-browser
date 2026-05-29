// Unread accounting — one pure pass over the notification list that yields the
// per-group, per-Tab, and per-Pin unread badge counts.
//
// Notifications are attributed by *group*, so every Tab and Pin of the same app
// (all Teams, all Outlook) shares one count whether or not it captured the
// toast, and a dormant Pin still badges by its saved URL's origin. The group key
// is `groupKey ?? originOf(targetUrl)`: today notifications carry no `groupKey`
// so the key is the URL origin (byte-identical to the prior by-origin behavior);
// task 028 introduces a real `groupKey` and this module is already ready for it.
//
// Pure: no React, no window, no DOM. Effects (building `linkedTabByPin`, wiring
// the result into the sidebar/bell) live in app.tsx.

/** The notification fields the aggregator reads. */
export interface UnreadNotification {
  read: boolean
  targetUrl?: string
  /** Absent today; introduced by task 028. Falls back to the targetUrl origin. */
  groupKey?: string
}

/** The Tab fields the aggregator reads. */
export interface UnreadTab {
  id: string
  url: string
}

/** The Pin fields the aggregator reads. */
export interface UnreadPin {
  id: string
  url: string
}

export interface UnreadResult {
  /** key = groupKey ?? origin → unread count */
  byGroup: Record<string, number>
  /** tab.id → unread count */
  byTab: Record<string, number>
  /** pin.id → unread count */
  byPin: Record<string, number>
}

function originOf(url: string | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/** A notification's group key: its explicit `groupKey`, else its targetUrl origin. */
function notificationKey(n: UnreadNotification): string | null {
  return n.groupKey ?? originOf(n.targetUrl)
}

/**
 * Tally unread notifications by group, then resolve each Tab and Pin to its
 * group's count. A Tab resolves through its own `url` origin; a Pin resolves
 * through its linked Tab's live `url` when linked (via `linkedTabByPin`), else
 * its saved `url`. Read notifications and inputs with no resolvable key get `0`.
 */
export function aggregateUnread(
  notifications: UnreadNotification[],
  tabs: UnreadTab[],
  pins: UnreadPin[],
  linkedTabByPin: Record<string, UnreadTab>,
): UnreadResult {
  const byGroup: Record<string, number> = {}
  for (const n of notifications) {
    if (n.read) continue
    const key = notificationKey(n)
    if (key) byGroup[key] = (byGroup[key] || 0) + 1
  }

  const byTab: Record<string, number> = {}
  for (const t of tabs) {
    const key = originOf(t.url)
    byTab[t.id] = key ? byGroup[key] || 0 : 0
  }

  const byPin: Record<string, number> = {}
  for (const pin of pins) {
    const key = originOf(linkedTabByPin[pin.id]?.url ?? pin.url)
    byPin[pin.id] = key ? byGroup[key] || 0 : 0
  }

  return { byGroup, byTab, byPin }
}
