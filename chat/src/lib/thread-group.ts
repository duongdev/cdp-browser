// Pure thread-shaping for the message list (t158 → t160). Turns a flat oldest→newest message array
// into render items: Messenger-style centered time separators (a new calendar day, or a ≥20-min idle
// gap — no inline per-message timestamps; the exact time lives in each bubble's tooltip),
// consecutive-sender grouping so a run of messages from one person within a short window shows the
// avatar/name once, and an optional Slack-style "New" last-read marker. No React, no I/O.
import type { TeamsMessage } from "./teams-client"

// A run of messages from one sender groups while gaps stay under this. Matches Slack's ~5min.
const GROUP_WINDOW_MS = 5 * 60_000
// A centered time separator appears after an idle gap of this much (Messenger's ~20min; grilled
// PSN-90 Phase 2 #4) — sender grouping stays on the tighter window above.
const SEPARATOR_WINDOW_MS = 20 * 60_000

/** Position of a chat message inside its same-sender run (t169) — drives the asymmetric bubble
 *  corners (the corners facing a group neighbour tighten; a solo bubble keeps the full radius). */
export type GroupPos = "solo" | "first" | "middle" | "last"

/** One render item in the thread, oldest→newest (the component reverses for flex-col-reverse). */
export type ThreadItem =
  | { type: "date"; key: string; label: string }
  | { type: "new"; key: string }
  | { type: "message"; key: string; message: TeamsMessage; showMeta: boolean; groupPos?: GroupPos }

/** A stable identity for a sender within a group run: own messages are all "self", others key by
 *  senderId (falling back to senderName so an id-less optimistic/legacy message still groups). */
function senderKey(m: TeamsMessage): string {
  if (m.self) return "\0self"
  return m.senderId || m.senderName || "\0unknown"
}

/** Local calendar-day bucket (YYYY-MM-DD in the viewer's timezone) — the day-boundary key. */
function dayKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

/** A centered separator label for a day, relative to `now`: "Today" / "Yesterday" / "Mon, Jul 21"
 *  (this year) / "Dec 12, 2025" (past years). Local time. */
export function dateSeparatorLabel(ts: number, now: number = Date.now()): string {
  const day = new Date(ts)
  const today = new Date(now)
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const diffDays = Math.round((startOf(today) - startOf(day)) / 86_400_000)
  if (diffDays === 0) return "Today"
  if (diffDays === 1) return "Yesterday"
  if (day.getFullYear() === today.getFullYear()) {
    return day.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })
  }
  return day.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
}

/** Messenger-style separator label (t160): day part only when the day changed ("Today 14:30" /
 *  "Mon, Jul 21 09:12"); a same-day idle gap shows just the time. Local time. */
export function timeSeparatorLabel(ts: number, withDay: boolean, now: number = Date.now()): string {
  const time = new Date(ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  return withDay ? `${dateSeparatorLabel(ts, now)} ${time}` : time
}

/** Reduce oldest→newest messages to render items (t158 → t160). A centered time separator opens
 *  each calendar day AND each ≥20-min idle gap (no inline timestamps — tooltip carries the exact
 *  time). `showMeta` is true only for a group leader — the first message of a run from one sender
 *  within GROUP_WINDOW_MS, not interrupted by a separator or a system line. When `lastReadTs` is
 *  set, a single "New" marker precedes the first non-self message newer than it (Slack's last-read
 *  line). Pure. */
export function buildThreadItems(
  messages: TeamsMessage[],
  now: number = Date.now(),
  lastReadTs: number | null = null,
): ThreadItem[] {
  const items: ThreadItem[] = []
  let prevDay: string | null = null
  let prevSender: string | null = null
  let prevTs = 0
  let prevSystem = false
  let newMarked = false

  for (const m of messages) {
    const isSystem = m.kind === "system"
    const day = dayKey(m.ts)
    const dayChanged = day !== prevDay
    const gapped = prevDay !== null && m.ts - prevTs > SEPARATOR_WINDOW_MS

    if (dayChanged || gapped) {
      items.push({
        type: "date",
        key: `sep:${m.id}`,
        label: timeSeparatorLabel(m.ts, dayChanged, now),
      })
    }

    // Slack-style last-read marker: once, before the first non-self chat message newer than the
    // watermark. Own messages never re-arm it — you read what you sent.
    if (
      lastReadTs != null &&
      !newMarked &&
      !isSystem &&
      !m.self &&
      !m.pending &&
      m.ts > lastReadTs
    ) {
      items.push({ type: "new", key: "new" })
      newMarked = true
    }

    if (isSystem) {
      items.push({ type: "message", key: m.id, message: m, showMeta: false })
    } else {
      const sender = senderKey(m)
      // Leader when a separator just rendered, the sender changed, the prior line was a system
      // event, or the gap since the previous message exceeded the group window.
      const showMeta =
        dayChanged ||
        gapped ||
        prevSystem ||
        sender !== prevSender ||
        m.ts - prevTs > GROUP_WINDOW_MS
      items.push({ type: "message", key: m.id, message: m, showMeta })
      prevSender = sender
    }

    prevTs = m.ts
    prevDay = day
    prevSystem = isSystem
  }

  // Second pass (t169): stamp each chat message's position in its same-sender run. A run starts at
  // a leader (showMeta) and continues through the showMeta=false messages that follow — separators/
  // system lines already force the next message to be a leader, so runs derive from the item
  // sequence alone.
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    if (it.type !== "message" || it.message.kind === "system" || !it.showMeta) continue
    let end = i
    while (end + 1 < items.length) {
      const next = items[end + 1]
      if (next.type !== "message" || next.message.kind === "system" || next.showMeta) break
      end++
    }
    if (end === i) it.groupPos = "solo"
    else {
      it.groupPos = "first"
      for (let j = i + 1; j < end; j++) (items[j] as { groupPos?: GroupPos }).groupPos = "middle"
      ;(items[end] as { groupPos?: GroupPos }).groupPos = "last"
    }
    i = end
  }
  return items
}
