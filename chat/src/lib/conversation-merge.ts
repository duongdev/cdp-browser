import type { TeamsConversation } from "./teams-client"

// Sort by most-recent activity: lastMessageTs desc, nulls last, id tie-break for stability.
function compareConv(a: TeamsConversation, b: TeamsConversation): number {
  const at = a.lastMessageTs
  const bt = b.lastMessageTs
  if (at == null && bt == null) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  if (at == null) return 1
  if (bt == null) return -1
  return bt - at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

function sameConv(a: TeamsConversation, b: TeamsConversation): boolean {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.title === b.title &&
    a.topic === b.topic &&
    a.lastMessageId === b.lastMessageId &&
    a.lastMessageVersion === b.lastMessageVersion &&
    a.lastMessageTs === b.lastMessageTs &&
    a.lastMessagePreview === b.lastMessagePreview &&
    a.muted === b.muted
  )
}

/** Merge a freshly polled first (newest) conversation page into the current list (t113, live sync).
 *  A matched id takes the fresh copy's fields; brand-new fresh conversations are inserted; existing
 *  conversations absent from `freshPage` (older "Load more" pages) are kept. The union is re-sorted
 *  by most-recent activity. Returns the same `existing` reference when the result is byte-identical,
 *  so the list can skip a re-render. */
export function mergeConversations(
  existing: TeamsConversation[],
  freshPage: TeamsConversation[],
): TeamsConversation[] {
  if (freshPage.length === 0) return existing

  const byId = new Map<string, TeamsConversation>()
  for (const c of existing) byId.set(c.id, c)
  for (const c of freshPage) byId.set(c.id, c)

  const merged = [...byId.values()].sort(compareConv)

  if (merged.length === existing.length && merged.every((c, i) => sameConv(c, existing[i]))) {
    return existing
  }
  return merged
}
