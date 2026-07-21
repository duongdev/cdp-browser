// Pure list-shaping helpers for the conversation list (t106). No React, no I/O — the row is
// presentation over these. Member-name resolution + HTML rendering land in t107, so for now a
// DM without a topic degrades to a kind label and the preview is tag-stripped raw content.
import type { TeamsConversation } from "./teams-client"

/** Display label: the topic if set, else a fallback keyed by conversation kind. */
export function conversationLabel(conv: TeamsConversation): string {
  const topic = conv.topic?.trim()
  if (topic) return topic
  return conv.kind === "oneOnOne" ? "Direct message" : "Group chat"
}

/** One-line last-message preview: tags stripped, whitespace collapsed, honest empty fallback. */
export function previewLine(conv: TeamsConversation): string {
  const text = conv.lastMessagePreview
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  return text || "No messages yet"
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Compact relative time; absolute month/day past a week. Empty for a missing timestamp. */
export function relativeTime(ts: number | null, now: number = Date.now()): string {
  if (ts == null || !Number.isFinite(ts)) return ""
  const diff = Math.max(0, now - ts)
  if (diff < MINUTE) return "now"
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m`
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h`
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}d`
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}
