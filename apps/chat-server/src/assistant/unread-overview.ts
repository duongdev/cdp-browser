// The catch-up digest's data shaper (t176): per-conversation unread counts + compact excerpts,
// read straight from the store. Unread derives via `effectiveReadTs` (ADR-0022's single owner —
// listConversations already applies it), never raw read_state columns. Strictly read-only: no
// read-state or horizon write anywhere. Muted conversations (provider mute OR local prefs mute)
// are skipped by default. Excerpts are capped hard — the tool result must stay compact.

import type BetterSqlite3 from "better-sqlite3"
import { stripHtml } from "../search.ts"
import { getAllPrefs, listConversations, listMessages } from "../store.ts"

type Db = BetterSqlite3.Database

export interface UnreadConversation {
  convId: string
  title: string
  unreadCount: number
  /** Oldest→newest unread excerpts, each "Sender: text" capped per line. */
  excerpts: { msgId: string; sender: string; ts: number | null; text: string }[]
}

const EXCERPTS_PER_CONV = 5
const EXCERPT_CHARS = 160
const MAX_CONVERSATIONS = 15

export function getUnreadOverview(
  db: Db,
  service: string,
  opts: { includeMuted?: boolean } = {},
): UnreadConversation[] {
  const prefs = getAllPrefs(db, service)
  const now = Date.now()
  const out: UnreadConversation[] = []
  for (const conv of listConversations(db, service)) {
    if (!conv.lastMessageTs || conv.lastMessageTs <= conv.readTs) continue
    if (conv.lastMessageFromMe) continue
    if (!opts.includeMuted) {
      const p = prefs[conv.id]
      const locallyMuted = p?.muted && (!p.mutedUntil || p.mutedUntil > now)
      if (conv.muted || locallyMuted) continue
    }
    // Newest page, then keep only the unread tail (ts > readTs), oldest→newest.
    const unread = listMessages(db, service, conv.id, { limit: 30 })
      .filter((m) => (m.ts ?? 0) > conv.readTs && !m.deleted)
      .reverse()
    if (unread.length === 0) continue
    out.push({
      convId: conv.id,
      title: conv.title || conv.topic || conv.id,
      unreadCount: unread.length,
      excerpts: unread.slice(-EXCERPTS_PER_CONV).map((m) => ({
        msgId: m.id,
        sender: m.senderName || m.senderId || "?",
        ts: m.ts,
        text: stripHtml(m.body).slice(0, EXCERPT_CHARS),
      })),
    })
    if (out.length >= MAX_CONVERSATIONS) break
  }
  return out
}
