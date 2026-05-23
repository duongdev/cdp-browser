// Presentation grouping for the notification popover. Pure — no rendering.

export interface ViewEntry {
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

export interface ConversationGroup<E extends ViewEntry = ViewEntry> {
  key: string
  label: string
  icon?: string | null
  items: E[]
  unread: number
}

// The conversation id (`targetEntity.id`) is the durable grouping key; the title is
// the fallback when it's absent. Input is newest-first, so the first entry seen for a
// key is its latest message — groups stay ordered by most-recent message, and items
// within a group stay newest-first, with no explicit sort.
function conversationKey(e: ViewEntry): string {
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
