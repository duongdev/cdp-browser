// Build the reply-quote blockquote Teams prepends to an outgoing quoted reply (PSN-92 workstream B/C).
// Shape mirrors the live-verified INCOMING reply markup (docs/plans/PSN-92): a schema.skype.com/Reply
// blockquote naming the quoted author (mri + display name), the original message id (on the blockquote
// and the time span), and a preview of the quoted text. The reply body is appended AFTER the block-
// quote(s) by the caller; multiple quotes stack (Teams' select-multiple behavior). Pure. The preview
// keeps inline emoji + plain text (issue 1: a plain-text preview dropped emoji) and is capped Teams-
// style (~120 visible chars). Send-side live verification pending (no self-chat mutation at build).
import { htmlToPlain } from "./html-to-plain"

const PREVIEW_CAP = 120

// A custom-emoji <img> (server-tagged `class="emoji"` or Teams' `itemtype=…/Emoji`) — kept verbatim in
// the preview so it renders; every other tag collapses to text.
const EMOJI_IMG =
  /<img\b[^>]*?(?:itemtype\s*=\s*(["'])[^"']*[Ee]moji[^"']*\1|class\s*=\s*(["'])[^"']*\bemoji\b[^"']*\2)[^>]*>/gi
// A nested reply blockquote inside the quoted body — dropped so a quote-of-a-quote doesn't recurse.
const NESTED_REPLY =
  /<blockquote\b[^>]*itemtype\s*=\s*(["'])[^"']*Reply[^"']*\1[\s\S]*?<\/blockquote>/gi

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/** A one-line preview of a quoted message: inline emoji kept, everything else reduced to plain text,
 *  capped at ~120 visible chars (an emoji counts as one). Output is safe inline HTML. */
export function quotePreviewHtml(bodyHtml: string, cap = PREVIEW_CAP): string {
  const src = (bodyHtml ?? "").replace(NESTED_REPLY, " ")
  let out = ""
  let visible = 0
  let last = 0
  let truncated = false

  const pushText = (raw: string) => {
    if (visible >= cap) {
      if (htmlToPlain(raw).trim()) truncated = true
      return
    }
    const text = htmlToPlain(raw).replace(/\s+/g, " ")
    if (!text) return
    const room = cap - visible
    if (text.length > room) {
      out += escapeHtml(text.slice(0, room))
      visible = cap
      truncated = true
    } else {
      out += escapeHtml(text)
      visible += text.length
    }
  }

  EMOJI_IMG.lastIndex = 0
  let m: RegExpExecArray | null = EMOJI_IMG.exec(src)
  while (m) {
    pushText(src.slice(last, m.index))
    if (visible < cap) {
      out += m[0]
      visible += 1
    } else {
      truncated = true
    }
    last = EMOJI_IMG.lastIndex
    m = EMOJI_IMG.exec(src)
  }
  pushText(src.slice(last))

  return truncated ? `${out.replace(/\s+$/, "")}…` : out.trim()
}

export interface ReplyQuote {
  /** The quoted message's id (Teams: its arrival ts, epoch ms as a string). */
  msgId: string
  /** The quoted author's bare MRI (`8:orgid:<oid>`). */
  authorMri: string
  /** The quoted author's FULL display name — the wire carries the real name; the Names setting is a
   *  render-time concern (applied by the body name pass), never baked into the sent quote. */
  authorName: string
  /** Inline-rich preview HTML of the quoted message (from `quotePreviewHtml`). */
  previewHtml: string
}

/** Emit the reply blockquote for `quote`. Concatenate the reply body (and any further quotes) around
 *  it to form the outgoing RichText/Html content. */
export function buildReplyBlockquote(quote: ReplyQuote): string {
  const id = escapeHtml(quote.msgId ?? "")
  const mri = escapeHtml(quote.authorMri ?? "")
  return (
    `<blockquote itemscope itemtype="http://schema.skype.com/Reply" itemid="${id}">` +
    `<strong itemprop="mri" itemid="${mri}">${escapeHtml(quote.authorName ?? "")}</strong>` +
    `<span itemprop="time" itemid="${id}"></span>` +
    `<p itemprop="preview">${quote.previewHtml ?? ""}</p>` +
    "</blockquote>"
  )
}

/** Concatenate stacked quotes (selection order) ahead of the reply body — the multi-reply wire form.
 *  A newline separates the blockquotes from the body, matching Teams' native reply markup. */
export function buildReplyBody(quotes: ReplyQuote[], bodyHtml: string): string {
  const blocks = quotes.map(buildReplyBlockquote).join("\n")
  return blocks ? `${blocks}\n${bodyHtml}` : bodyHtml
}
