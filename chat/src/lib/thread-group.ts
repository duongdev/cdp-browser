// Pure thread-shaping for the message list (t158). Turns a flat oldest→newest message array into
// render items: centered date separators between calendar days, and consecutive-sender grouping so a
// run of messages from one person within a short window shows the avatar/name/time once (Slack-style)
// while followers render as bare bubbles. No React, no I/O — MessageRow presentation reads `showMeta`.
import type { TeamsMessage } from "./teams-client"

// A run of messages from one sender groups while gaps stay under this. Matches Slack's ~5min.
const GROUP_WINDOW_MS = 5 * 60_000

/** One render item in the thread, oldest→newest (the component reverses for flex-col-reverse). */
export type ThreadItem =
  | { type: "date"; key: string; label: string }
  | { type: "message"; key: string; message: TeamsMessage; showMeta: boolean }

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

/** Reduce oldest→newest messages to render items (t158): a date separator opens each new calendar
 *  day, and `showMeta` is true only for a group leader — the first message of a run from one sender
 *  within GROUP_WINDOW_MS on the same day. A group breaks on: a different sender, a >5min gap, a day
 *  boundary, or a system line (which never groups and carries no meta). Pure. */
export function buildThreadItems(messages: TeamsMessage[], now: number = Date.now()): ThreadItem[] {
  const items: ThreadItem[] = []
  let prevDay: string | null = null
  let prevSender: string | null = null
  let prevTs = 0
  let prevSystem = false

  for (const m of messages) {
    const isSystem = m.kind === "system"
    const day = dayKey(m.ts)

    if (day !== prevDay) {
      items.push({ type: "date", key: `date:${day}`, label: dateSeparatorLabel(m.ts, now) })
    }

    if (isSystem) {
      items.push({ type: "message", key: m.id, message: m, showMeta: false })
    } else {
      const sender = senderKey(m)
      // Leader when the day just changed, the sender changed, the prior line was a system event, or
      // the gap since the previous message exceeded the group window.
      const showMeta =
        day !== prevDay || prevSystem || sender !== prevSender || m.ts - prevTs > GROUP_WINDOW_MS
      items.push({ type: "message", key: m.id, message: m, showMeta })
      prevSender = sender
      prevTs = m.ts
    }

    prevDay = day
    prevSystem = isSystem
  }
  return items
}
