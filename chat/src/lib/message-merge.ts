import type { TeamsMessage, TeamsReaction } from "./teams-client"

// Order-independent signature of a message's reactions, so a poll re-render fires when a reaction is
// added/removed but not when the same set arrives in a different array order (Teams' emotions order
// isn't stable). Compares key + count + mine — the three fields the chip renders.
const reactionSig = (m: TeamsMessage): string =>
  (m.reactions ?? [])
    .map((r) => `${r.key}:${r.count}:${r.mine ? 1 : 0}`)
    .sort()
    .join("|")

/** Merge a freshly polled newest history page into the current thread (t135, poll-first live sync).
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
 *  older ones needs a trouter subscription, deferred (t135 is poll-first). */
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
        m.ts !== e.ts ||
        reactionSig(m) !== reactionSig(e)
      )
    })

  return changed ? { messages, changed: true } : { messages: existing, changed: false }
}

/** Optimistically toggle the viewer's own reaction for one key, returning the new reactions array
 *  (never mutates the input). `remove` false → I join the key (new key if absent); true → I leave it
 *  (the key is dropped when I was the only reactor). A no-op re-add of my existing reaction returns
 *  the same shape. The server call + next poll reconcile the true count. */
export function applyReaction(
  reactions: TeamsReaction[] | undefined,
  key: string,
  emoji: string,
  remove: boolean,
): TeamsReaction[] {
  const list = reactions ?? []
  const existing = list.find((r) => r.key === key)
  if (remove) {
    if (!existing?.mine) return list
    return list
      .map((r) => (r.key === key ? { ...r, count: r.count - 1, mine: false } : r))
      .filter((r) => r.count > 0)
  }
  if (!existing) return [...list, { key, emoji, count: 1, mine: true }]
  if (existing.mine) return list
  return list.map((r) => (r.key === key ? { ...r, count: r.count + 1, mine: true } : r))
}

/** One in-flight optimistic reaction: the emoji to draw and whether the viewer should end up in it.
 *  (`thread-view` also tracks a `ts` for the failed-write timeout; the overlay ignores it.) */
interface PendingReaction {
  emoji: string
  desiredMine: boolean
}

/** Re-apply the viewer's pending (optimistic) reactions on top of a freshly merged message list, so
 *  a poll whose server response hasn't propagated the reaction yet can't revert it (t143). Keyed by
 *  (msgId → key → desiredMine): for each pending key it forces `mine` to `desiredMine` — add/mark-mine
 *  + bump count when desired but absent/not-mine, unmark + decrement (drop the chip at 0) when not
 *  desired but currently mine. Never mutates the input; returns the same array ref when nothing
 *  changed (so the caller's same-ref no-render optimization holds). The overlay self-heals — the
 *  caller drops a pending entry once the server reflects it, so this can't mask a real later change. */
export function applyPendingReactions(
  messages: TeamsMessage[],
  pending: ReadonlyMap<string, ReadonlyMap<string, PendingReaction>>,
): TeamsMessage[] {
  if (pending.size === 0) return messages
  let changed = false
  const out = messages.map((m) => {
    const keys = pending.get(m.id)
    if (!keys || keys.size === 0) return m
    let reactions = m.reactions ?? []
    let msgChanged = false
    for (const [key, { emoji, desiredMine }] of keys) {
      const existing = reactions.find((r) => r.key === key)
      const currentlyMine = existing?.mine ?? false
      if (currentlyMine === desiredMine) continue
      msgChanged = true
      if (desiredMine) {
        reactions = existing
          ? reactions.map((r) => (r.key === key ? { ...r, count: r.count + 1, mine: true } : r))
          : [...reactions, { key, emoji, count: 1, mine: true }]
      } else {
        reactions = reactions
          .map((r) => (r.key === key ? { ...r, count: r.count - 1, mine: false } : r))
          .filter((r) => r.count > 0)
      }
    }
    if (!msgChanged) return m
    changed = true
    return { ...m, reactions }
  })
  return changed ? out : messages
}
