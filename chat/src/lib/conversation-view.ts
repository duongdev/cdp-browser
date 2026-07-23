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
