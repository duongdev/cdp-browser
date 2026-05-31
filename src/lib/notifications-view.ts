// Presentation grouping for the notification popover. Pure — no rendering.

import { type ActivateIntent, deriveLegacyActivate } from "./notification-activation"

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
  // Newest-first, capped to GROUP_ITEM_CAP. `total`/`unread` count the whole thread.
  items: E[]
  total: number
  unread: number
}

// Show only the latest few messages per thread; older ones collapse into a count.
export const GROUP_ITEM_CAP = 3

// The popover groups by *conversation thread*, not by app/origin: a Teams chat and a
// Teams channel are distinct threads even though they share an origin. (Sidebar badges
// still aggregate per-app via `groupKey` — see `unread-aggregator.ts`; the two grouping
// concerns are deliberately separate.) The thread is scoped by `groupKey` so two
// workspaces can never merge a coincidentally-equal thread id. The legacy `targetEntity`
// shape is normalized through the same `deriveLegacyActivate` the click path uses, so a
// pre-`activate` backlog message keys identically to a fresh one of the same conversation
// (grouping and mark-thread-read stay in agreement). Resolution: a Teams `thread` id (one
// key per conversation, shared by all its messages), else an Outlook `spa-link` (its
// per-message deep-link, so unrelated same-subject mail never collapses — and opening one
// never marks another read), else the entity id / title / source. Input is newest-first,
// so the first entry seen for a key is its latest message — groups stay ordered by
// most-recent message and items within stay newest-first.
export function threadKey(e: ViewEntry): string {
  const scope = e.groupKey || ""
  const activate = e.activate ?? deriveLegacyActivate(e.targetEntity)
  let thread: string
  if (activate?.type === "thread") {
    thread = `t:${activate.id}`
  } else if (activate?.type === "spa-link") {
    thread = `l:${activate.url}`
  } else {
    const entity = e.targetEntity as { id?: string } | null | undefined
    thread = (entity && typeof entity.id === "string" && entity.id) || e.title || e.source || ""
  }
  return scope ? `${scope}::${thread}` : thread
}

// Flatten the grouped popover back into one paint-ordered row list — group order
// outer, the (capped) `items` within each group inner. Mirrors exactly what the bell
// paints (collapsed/earlier messages are excluded), so roving keyboard selection indexes
// the same rows the user sees. Pure.
export function flattenRows<E extends ViewEntry>(groups: ConversationGroup<E>[]): E[] {
  return groups.flatMap((g) => g.items)
}

export function groupByConversation<E extends ViewEntry>(list: E[]): ConversationGroup<E>[] {
  const groups: ConversationGroup<E>[] = []
  const byKey = new Map<string, ConversationGroup<E>>()
  for (const e of list) {
    const key = threadKey(e)
    let g = byKey.get(key)
    if (!g) {
      g = { key, label: e.title || e.source, icon: e.icon, items: [], total: 0, unread: 0 }
      byKey.set(key, g)
      groups.push(g)
    }
    g.total += 1
    if (g.items.length < GROUP_ITEM_CAP) g.items.push(e)
    if (!e.read) g.unread += 1
  }
  return groups
}
