// Rich-composer output shaping (t159). The composer is a contenteditable div, so its raw value is
// browser-authored HTML. This module turns that into what the send path needs: the plain text (for
// the optimistic bubble + the Text-messagetype fast path) and, only when real formatting is present,
// a cleaned HTML payload for a `RichText/Html` send. Pure string transforms (node test env, no DOM)
// — mirrors html-to-plain's ponytail approach.
import { htmlToPlain } from "./html-to-plain"

// Tags that count as formatting (anything a Text-messagetype send would lose). div/br/p/span are
// just line structure — a plain multi-line message stays a Text send.
const FORMAT_TAG_RE = /<(b|strong|i|em|u|s|strike|del|ul|ol|li|a|code|pre|blockquote)\b/i

// The tags an outgoing RichText/Html body may carry. Everything else is dropped (content kept).
const ALLOWED_TAGS = new Set([
  "b",
  "strong",
  "i",
  "em",
  "u",
  "s",
  "strike",
  "del",
  "br",
  "div",
  "p",
  "span",
  "ul",
  "ol",
  "li",
  "a",
  "code",
  "pre",
  "blockquote",
])

/** Strip the editor's HTML down to the outgoing allowlist: disallowed tags are removed (their text
 *  kept), and allowed tags lose every attribute except an `<a href>` (http/https/mailto only). The
 *  render side has its own DOMPurify boundary — this only keeps the payload we hand Teams tidy. */
export function cleanEditorHtml(html: string): string {
  if (!html) return ""
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\s*(\/?)\s*([a-z0-9]+)((?:[^>"']|"[^"]*"|'[^']*')*)>/gi, (_m, close, tag, attrs) => {
      const t = tag.toLowerCase()
      if (!ALLOWED_TAGS.has(t)) return ""
      if (close) return `</${t}>`
      if (t === "a") {
        const href = /\bhref\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attrs)
        const url = href?.[2] ?? href?.[3] ?? ""
        if (/^(https?:|mailto:)/i.test(url)) return `<a href="${url}">`
        return "<a>"
      }
      if (t === "br") return "<br>"
      return `<${t}>`
    })
}

/** Escape plain text into display HTML with newlines as <br> — the optimistic bubble body for a
 *  formatting-free send (the render path is always HTML). */
export function textToHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>")
}

/** What the Enter key does in the composer. Enter sends (the chat default), BUT inside a list it must
 *  add / exit a list item (native contenteditable behavior) — otherwise a bulleted/numbered list can
 *  never grow past one item (PSN-92). Shift+Enter is a soft line break; Cmd/Ctrl+Enter always sends,
 *  so a list-only message is still sendable from the keyboard. Pure — the DOM check is the caller's. */
export function enterKeyAction(o: {
  shift: boolean
  meta: boolean
  inListItem: boolean
}): "send" | "default" {
  if (o.meta) return "send"
  if (o.shift) return "default"
  if (o.inListItem) return "default"
  return "send"
}

export interface OutgoingMessage {
  /** Visible plain text — the optimistic bubble + the Text-send body. Empty = nothing to send. */
  text: string
  /** Cleaned HTML for a RichText/Html send; null when the content carries no formatting. */
  html: string | null
}

/** Shape a contenteditable's innerHTML into the outgoing send payload. Whitespace-only → empty text
 *  (caller sends nothing). Formatting present → both text and html; plain (even multi-line) → text
 *  only, so the wire format stays the existing Text send. */
export function outgoingFromEditor(raw: string): OutgoingMessage {
  const cleaned = cleanEditorHtml(raw)
  const text = htmlToPlain(cleaned)
  if (!text) return { text: "", html: null }
  return { text, html: FORMAT_TAG_RE.test(cleaned) ? cleaned : null }
}
