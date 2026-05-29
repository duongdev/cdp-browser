// Presentation grouping for the notification popover. Pure — no rendering.

import type { ActivateIntent } from "./notification-activation"

export interface ViewEntry {
  id: string
  // Matched Notification Adapter name (e.g. "teams", "outlook"), stamped by the
  // shared notification center.
  adapter?: string | null
  source: string
  title: string
  body: string
  targetId: string
  targetUrl?: string
  // Stable grouping id stamped by the center (default = the targetUrl origin). The
  // popover groups by this key; a Slack adapter can emit "slack:{teamId}" to split
  // workspaces without any consumer change.
  groupKey?: string
  targetEntity?: unknown
  // Normalized deep-open intent emitted by the capture script (semantic ids only —
  // no DOM selectors). Absent → clicking only activates the owning Tab.
  activate?: ActivateIntent | null
  icon?: string | null
  ts: number
  read: boolean
}

export interface ConversationGroup<E extends ViewEntry = ViewEntry> {
  key: string
  label: string
  icon?: string | null
  items: E[]
  unread: number
}

// The center-stamped `groupKey` is the durable grouping key (default = targetUrl
// origin; a future Slack adapter emits "slack:{teamId}" to split workspaces). When a
// legacy entry carries none, fall back to the conversation id / title / source. Input
// is newest-first, so the first entry seen for a key is its latest message — groups
// stay ordered by most-recent message, and items within a group stay newest-first,
// with no explicit sort.
function conversationKey(e: ViewEntry): string {
  if (e.groupKey) return e.groupKey
  const entity = e.targetEntity as { id?: string } | null | undefined
  return entity?.id || e.title || e.source
}

export function groupByConversation<E extends ViewEntry>(list: E[]): ConversationGroup<E>[] {
  const groups: ConversationGroup<E>[] = []
  const byKey = new Map<string, ConversationGroup<E>>()
  for (const e of list) {
    const key = conversationKey(e)
    let g = byKey.get(key)
    if (!g) {
      g = { key, label: e.title || e.source, icon: e.icon, items: [], unread: 0 }
      byKey.set(key, g)
      groups.push(g)
    }
    g.items.push(e)
    if (!e.read) g.unread += 1
  }
  return groups
}
