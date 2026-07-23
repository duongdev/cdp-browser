// Pure list-shaping helpers for the conversation list (t128). No React, no I/O — the row is
// presentation over these. Member-name resolution + HTML rendering land in t129, so for now a
// DM without a topic degrades to a kind label and the preview is tag-stripped raw content.
import type { TeamsConversation } from "./teams-client"

/** Display label: the server-resolved title (real member names, t131) if present, else the topic,
 *  else a fallback keyed by conversation kind. */
export function conversationLabel(conv: TeamsConversation): string {
  const title = conv.title?.trim()
  if (title) return title
  const topic = conv.topic?.trim()
  if (topic) return topic
  if (conv.kind === "self") return "Notes"
  return conv.kind === "oneOnOne" ? "Direct message" : "Group chat"
}

/** One-line last-message preview (t151). The list stores the RAW last-message content, so a quoted
 *  reply, a system event, or a card would otherwise leak markup/XML. This reduces any shape to one
 *  clean plain-text line. Mirrors core/teams-render.js `previewText` (the CJS core can't be imported
 *  into the typechecked chat bundle); its live-shape branches are tested there + here. */
export function previewLine(conv: TeamsConversation): string {
  return previewText(conv.lastMessagePreview) || "No messages yet"
}

// First <tag>…</tag> inner text, markup-stripped, or "".
function tagText(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i"))
  return m ? m[1].replace(/<[^>]+>/g, "").trim() : ""
}

// Tag-strip + entity-decode-lite + whitespace-collapse to a single plain line. Also drops a trailing
// UNTERMINATED tag (the store caps raw content at 500 chars, which can cut a tag mid-attribute).
function plainText(html: string): string {
  return html
    .replace(/<[^>]*$/, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;|&#xa0;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim()
}

/** Reduce a raw last-message content string to one clean preview line (t151). Mirror of
 *  core/teams-render.js `previewText`. Empty content → "". */
export function previewText(rawContent: string): string {
  const content = typeof rawContent === "string" ? rawContent : ""
  if (!content.trim()) return ""

  // System / control XML payloads (no messagetype in the list — detect by shape).
  if (/^\s*<ended\/>/i.test(content)) return "Call ended"
  if (/^\s*<partlist\b/i.test(content) || /<meetingDetails\b/i.test(content)) return "Meeting"
  if (/^\s*<topicupdate\b/i.test(content)) {
    const v = tagText(content, "value")
    return v ? `Renamed to "${v}"` : "Renamed the conversation"
  }
  if (/^\s*<(add|delete)member\b/i.test(content)) return "Membership changed"
  if (/^\s*<AddCustomApp\b/i.test(content)) {
    const app = tagText(content, "targetName")
    return app ? `Added the ${app} app` : "Added an app"
  }
  if (/^\s*<meetingpolicyupdated\b|^\s*<UpdateFavDefault\b/i.test(content)) return ""
  // A call transcript / recording pointer (Media_CallTranscript JSON) — a control artifact, no value.
  if (/scopeId\\?"\s*:|"callId\\?"\s*:/.test(content) && /^\s*[{\\]/.test(content)) return ""
  // A card (URIObject SWIFT / recording): its title, else a label.
  if (/<URIObject\b/i.test(content)) {
    if (/CallRecording/i.test(content)) return "Call recording"
    return tagText(content, "Title") || "Card"
  }

  // Inline images become a 📷 token FIRST (emoji imgs keep their alt char). The `(?:>|$)` also
  // catches a tag the store's PREVIEW_CAP truncated mid-attribute — plainText's `<[^>]+>` can't
  // strip an unterminated tag, which is how `<img it…` leaked into the list (t151).
  const s = content
    .replace(
      /<img\b[^>]*\bitemtype\s*=\s*(["'])[^"']*Emoji[^"']*\1[^>]*(?:>|$)/gi,
      (m) => (m.match(/\balt\s*=\s*(["'])([^"']*)\1/i) || [])[2] || "",
    )
    .replace(/<img\b[^>]*(?:>|$)/gi, " 📷 ")

  // A quoted reply: drop the blockquote, keep the replier's own words; if none, show the reply glyph
  // + the quoted preview.
  const quoteM = s.match(
    /<blockquote\b[^>]*itemtype\s*=\s*(["'])[^"']*Reply[^"']*\1[\s\S]*?<p\b[^>]*itemprop\s*=\s*(["'])preview\2[^>]*>([\s\S]*?)<\/p>/i,
  )
  const quotePreview = quoteM ? plainText(quoteM[3]) : ""
  const own = plainText(
    s.replace(
      /<blockquote\b[^>]*itemtype\s*=\s*(["'])[^"']*Reply[^"']*\1[\s\S]*?<\/blockquote>/gi,
      " ",
    ),
  )
  if (own) return own
  return quotePreview ? `↩ ${quotePreview}` : ""
}

/** Pure unread test (t155). A conversation is unread when its last message is newer than the
 *  effective read watermark (`readTs` — the higher of the Teams consumptionHorizon and the local
 *  read, or 0 under a mark-unread sentinel) AND the last message isn't the viewer's own send. The
 *  `unreadSticky` sentinel forces unread even when `readTs` would otherwise cover it (server already
 *  zeroes `readTs` in that case, so the ts check suffices; the flag is kept for an explicit read). */
export function isUnread(conv: TeamsConversation): boolean {
  // A muted conversation (t156, local pref) contributes nothing to the unread/badge signal — mute
  // wins over unread in display. The conv's `muted` is set by applyPrefs (or the server row).
  if (conv.muted) return false
  if (conv.lastMessageFromMe) return false
  if (conv.lastMessageTs == null) return false
  return conv.lastMessageTs > (conv.readTs || 0)
}

/** An optimistic client-side read-state patch (t155). Applied over the server row INSIDE
 *  ConversationList (the rows render from the list's own state, so patching any other copy never
 *  reaches the screen): opening a thread / mark-read lays a "read" override (readTs floor at `ts` —
 *  a LATER message still re-arms the dot), mark-unread forces the sticky-unread shape. Overrides
 *  never expire — a "read" override is a no-op once the server readTs covers it, and an "unread"
 *  override mirrors the server sentinel the action just wrote. */
export interface ReadOverride {
  action: "read" | "unread"
  /** The last-message ts at patch time — the watermark a "read" override raises readTs to. */
  ts: number
}

/** Apply an override to a server conversation row (pure). Returns the same reference when the
 *  override changes nothing. */
export function applyReadOverride(
  conv: TeamsConversation,
  override?: ReadOverride,
): TeamsConversation {
  if (!override) return conv
  if (override.action === "read") {
    if (conv.readTs >= override.ts && !conv.unreadSticky) return conv
    return { ...conv, readTs: Math.max(conv.readTs, override.ts), unreadSticky: false }
  }
  if (conv.readTs === 0 && conv.unreadSticky) return conv
  return { ...conv, readTs: 0, unreadSticky: true }
}

// ── Conversation prefs: labels / folder / mute (t156, Workstream K) ─────────────────────────────
// Local-only organisation, shared server-side but NEVER written to Teams. Fetched as a map beside
// the list and re-applied over polled rows (a poll can't clobber a pref), same pattern as t155's
// read overrides.

/** One conversation's local prefs (mirror of the server's teams-store shape). */
export interface ConvPrefs {
  labels: string[]
  folder: string | null
  muted: boolean
}

export const EMPTY_PREFS: ConvPrefs = { labels: [], folder: null, muted: false }

/** Merge a conversation's prefs onto the server row: `muted` OR'd with the pref, `labels`/`folder`
 *  carried on the row for the UI. Returns the same reference when nothing changes. Pure. */
export function applyPrefs(conv: TeamsConversation, prefs?: ConvPrefs): TeamsConversation {
  if (!prefs) return conv
  const muted = conv.muted || prefs.muted
  const hasLabels = prefs.labels.length > 0
  if (muted === conv.muted && !hasLabels && !prefs.folder) return conv
  return { ...conv, muted, labels: prefs.labels, folder: prefs.folder }
}

/** A folder section (or the ungrouped bucket) for the grouped list view. */
export interface FolderSection {
  /** The folder name, or null for the ungrouped rows. */
  folder: string | null
  conversations: TeamsConversation[]
}

/** Group a (pref-applied, already list-sorted) conversation list into folder sections. Folder
 *  sections come first, alpha-sorted by name (locale-aware, case-insensitive); the ungrouped rows
 *  follow as a trailing section (folder: null). Each section keeps the incoming order (the list is
 *  already newest-first). A conversation's folder is read from `conv.folder` (set by applyPrefs).
 *  Pure — the row/section rendering is presentation over this. */
export function groupByFolder(conversations: TeamsConversation[]): FolderSection[] {
  const folders = new Map<string, TeamsConversation[]>()
  const ungrouped: TeamsConversation[] = []
  for (const c of conversations) {
    const f = c.folder?.trim()
    if (f) {
      const arr = folders.get(f)
      if (arr) arr.push(c)
      else folders.set(f, [c])
    } else ungrouped.push(c)
  }
  const sections: FolderSection[] = [...folders.keys()]
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
    .map((folder) => ({ folder, conversations: folders.get(folder) as TeamsConversation[] }))
  // Trailing ungrouped section — only when non-empty AND there are folders (otherwise a flat list).
  if (ungrouped.length > 0) sections.push({ folder: null, conversations: ungrouped })
  return sections
}

/** The conversations in the exact VISUAL order the list renders them (folder sections first, then
 *  ungrouped), with any collapsed folder's rows dropped. This is the order keyboard j/k must walk —
 *  the raw list is newest-first, but folder grouping reorders the rows and a collapsed folder hides
 *  its rows entirely, so navigating the raw list lands the focus ring on an off-screen row (t157).
 *  Pure: `groupByFolder` is the render's own grouping, so this can't drift from what's shown. */
export function navigableConversations(
  conversations: TeamsConversation[],
  collapsed?: ReadonlySet<string>,
): TeamsConversation[] {
  const out: TeamsConversation[] = []
  for (const section of groupByFolder(conversations)) {
    if (section.folder && collapsed?.has(section.folder)) continue
    out.push(...section.conversations)
  }
  return out
}

/** Every distinct folder name in a prefs map, alpha-sorted — the "Move to folder" submenu source. */
export function knownFolders(prefs: Record<string, ConvPrefs>): string[] {
  const set = new Set<string>()
  for (const p of Object.values(prefs)) if (p.folder) set.add(p.folder)
  return [...set].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
}

/** Every distinct label across all conversations, alpha-sorted — the "Labels" menu toggle source. */
export function knownLabels(prefs: Record<string, ConvPrefs>): string[] {
  const set = new Set<string>()
  for (const p of Object.values(prefs)) for (const l of p.labels) set.add(l)
  return [...set].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
}

/** Toggle a label in a list (add if absent, remove if present). Pure — the caller POSTs the result. */
export function toggleLabel(labels: string[], label: string): string[] {
  const t = label.trim()
  if (!t) return labels
  return labels.includes(t) ? labels.filter((l) => l !== t) : [...labels, t]
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
