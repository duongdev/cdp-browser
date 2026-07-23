// Build the reply-quote blockquote Teams prepends to an outgoing quoted reply (PSN-92 workstream B).
// Shape mirrors the live-verified INCOMING reply markup (docs/plans/PSN-92): a schema.skype.com/Reply
// blockquote naming the quoted author (mri + display name), the original message id (on the blockquote
// and the time span), and a one-line preview of the quoted text. The reply body is appended AFTER the
// blockquote by the caller. Pure; author name + preview are HTML-escaped; preview is truncated Teams-
// style (~120 chars). Send-side live verification pending (no self-chat mutation at build).
const PREVIEW_CAP = 120

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/** Collapse whitespace and cap a quoted preview at PREVIEW_CAP chars (ellipsis when clipped). */
export function truncatePreview(text: string): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim()
  return t.length > PREVIEW_CAP ? `${t.slice(0, PREVIEW_CAP - 1)}…` : t
}

export interface ReplyQuote {
  /** The quoted message's id (Teams: its arrival ts, epoch ms as a string). */
  msgId: string
  /** The quoted author's bare MRI (`8:orgid:<oid>`). */
  authorMri: string
  /** The quoted author's display name. */
  authorName: string
  /** Plain-text body of the quoted message (already tag-stripped). */
  previewText: string
}

/** Emit the reply blockquote for `quote`. Concatenate the reply body after it to form the outgoing
 *  RichText/Html content. */
export function buildReplyBlockquote(quote: ReplyQuote): string {
  const id = escapeHtml(quote.msgId ?? "")
  const mri = escapeHtml(quote.authorMri ?? "")
  return (
    `<blockquote itemscope itemtype="http://schema.skype.com/Reply" itemid="${id}">` +
    `<strong itemprop="mri" itemid="${mri}">${escapeHtml(quote.authorName ?? "")}</strong>` +
    `<span itemprop="time" itemid="${id}"></span>` +
    `<p itemprop="preview">${escapeHtml(truncatePreview(quote.previewText ?? ""))}</p>` +
    "</blockquote>"
  )
}
