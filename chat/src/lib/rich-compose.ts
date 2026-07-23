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

/** One per-token @mention entry for `properties.mentions` (PSN-92 D). Teams splits ONE person into a
 *  span PER whitespace token of the display name, every token mapping to the same mri. */
export interface MentionToken {
  itemid: number
  mri: string
  displayName: string
}

export interface OutgoingMessage {
  /** Visible plain text — the optimistic bubble + the Text-send body. Empty = nothing to send. */
  text: string
  /** Cleaned HTML for a RichText/Html send; null when the content carries no formatting/mention.
   *  Mentions ride as per-token `itemtype=…/Mention` spans (the live-verified wire form). */
  html: string | null
  /** HTML for the OPTIMISTIC bubble — mentions render as one `.mention` pill (the server merges the
   *  per-token wire spans, but the client can't, so it uses this until the poll reconciles). Null when
   *  the plain-text path covers it. */
  displayHtml: string | null
  /** The per-token mention entries for `properties.mentions`. Empty when there are no @mentions. */
  mentions: MentionToken[]
}

// A composer mention pill: <span class="mention" data-mri="MRI" data-name="FULL" ...>@Display</span>.
// data-name (the FULL name) drives the wire tokens; the visible text is cosmetic.
const PILL_RE = /<span\b([^>]*\bdata-mri\b[^>]*)>[\s\S]*?<\/span>/gi
// Private-use sentinels bracketing a pill placeholder — cannot occur in editor HTML, survive
// cleanEditorHtml as plain text, safe as literal regex chars.
const OPEN = String.fromCharCode(0xe010)
const CLOSE = String.fromCharCode(0xe011)

function attr(tag: string, name: string): string {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i"))
  return m ? m[1] : ""
}
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
}
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/** Shape a contenteditable's innerHTML into the outgoing send payload. Whitespace-only → empty text
 *  (caller sends nothing). Formatting or an @mention present → both text and html; plain (even multi-
 *  line) → text only, so the wire format stays the existing Text send. Mention pills survive
 *  cleanEditorHtml (which strips attrs) via a placeholder round-trip. */
export function outgoingFromEditor(raw: string): OutgoingMessage {
  // Pull the mention pills out to placeholders so cleanEditorHtml doesn't strip their mri/name.
  const pills: { mri: string; name: string }[] = []
  const withPlaceholders = raw.replace(PILL_RE, (_m, attrs) => {
    const mri = attr(attrs, "data-mri")
    const name = decodeEntities(attr(attrs, "data-name")).trim()
    const idx = pills.length
    pills.push({ mri, name })
    return `${OPEN}${idx}${CLOSE}`
  })

  const cleaned = cleanEditorHtml(withPlaceholders)
  const placeholderText = cleaned.replace(
    new RegExp(`${OPEN}(\\d+)${CLOSE}`, "g"),
    (_m, i) => `@${pills[Number(i)]?.name ?? ""}`,
  )
  const text = htmlToPlain(placeholderText)
  if (!text) return { text: "", html: null, displayHtml: null, mentions: [] }

  let itemid = 0
  const mentions: MentionToken[] = []
  const wireHtml = cleaned.replace(new RegExp(`${OPEN}(\\d+)${CLOSE}`, "g"), (_m, i) => {
    const pill = pills[Number(i)]
    if (!pill) return ""
    const tokens = pill.name.split(/\s+/).filter(Boolean)
    if (!tokens.length) return ""
    return tokens
      .map((t) => {
        const id = itemid++
        mentions.push({ itemid: id, mri: pill.mri, displayName: t })
        return `<span itemtype="http://schema.skype.com/Mention" itemscope="" itemid="${id}">${esc(t)}</span>`
      })
      .join("&nbsp;")
  })
  const displayHtml = cleaned.replace(new RegExp(`${OPEN}(\\d+)${CLOSE}`, "g"), (_m, i) => {
    const pill = pills[Number(i)]
    return pill ? `<span class="mention">@${esc(pill.name)}</span>` : ""
  })

  const rich = FORMAT_TAG_RE.test(cleaned) || mentions.length > 0
  return {
    text,
    html: rich ? wireHtml : null,
    displayHtml: rich ? displayHtml : null,
    mentions,
  }
}
