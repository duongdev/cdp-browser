import type { TeamsMessage } from "./teams-client"

/** Merge a freshly polled newest history page into the current thread (t113, poll-first live sync).
 *  The server returns full messages, so an id collision means "incoming (server) wins" — this
 *  reconciles edits (body/edited), deletes (deleted), and collapses the optimistic-send echo (its
 *  id is the server ts) to one bubble. New ids append; the union is re-sorted oldest-first (ts asc,
 *  id tie-break) to match render order.
 *
 *  `changed` is true only when the result differs from `existing` in length or an identity-relevant
 *  field (id/body/edited/deleted/ts), so the caller can skip a re-render when a poll adds nothing.
 *  Returns the same `existing` reference when unchanged.
 *
 *  ponytail: only reconciles edits/deletes for messages inside the newest polled page — reconciling
 *  older ones needs a trouter subscription, deferred (t113 is poll-first). */
export function mergeMessages(
  existing: TeamsMessage[],
  incoming: TeamsMessage[],
): { messages: TeamsMessage[]; changed: boolean } {
  if (incoming.length === 0) return { messages: existing, changed: false }

  const byId = new Map<string, TeamsMessage>()
  for (const m of existing) byId.set(m.id, m)
  for (const m of incoming) byId.set(m.id, m)

  const messages = [...byId.values()].sort(
    (a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )

  const changed =
    messages.length !== existing.length ||
    messages.some((m, i) => {
      const e = existing[i]
      return (
        m.id !== e.id ||
        m.body !== e.body ||
        m.edited !== e.edited ||
        m.deleted !== e.deleted ||
        m.ts !== e.ts
      )
    })

  return changed ? { messages, changed: true } : { messages: existing, changed: false }
}
