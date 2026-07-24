// Apply the Names setting (t161) to person-names baked into a message body's HTML (PSN-92 E): the
// `@mention` pills and the reply-quote author. Both are produced server-side with the FULL name, so
// the Names preference — a render concern — is applied here, on the raw (pre-sanitize) body where the
// `.mention` class and the quote's `itemprop="mri"` are still visible. When the preference shortens a
// name we stamp `data-fullname` (survives the sanitizer, which allowlists it) so a hover tooltip can
// reveal the full name (decision 5 — tooltip only when shortened). Pure string transform (node test
// env, no DOM); mirrors the formatName seam used by the React name spots.
import { formatName, type NamePref } from "./display-name"

const MENTION_SPAN =
  /<span\b([^>]*\bclass\s*=\s*(["'])[^"']*\bmention\b[^"']*\2[^>]*)>([\s\S]*?)<\/span>/gi
// A reply-quote author: <strong itemprop="mri" …>Name</strong>. Capture the open tag + inner + close.
const QUOTE_STRONG =
  /(<strong\b(?=[^>]*\bitemprop\s*=\s*(["'])mri\2)[^>]*)(>)([\s\S]*?)(<\/strong>)/gi

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "")
}

// Decode the few entities a display name can carry so formatName sees the real text; the output is
// re-encoded, so no double-escaping.
function decode(s: string): string {
  return s
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
}
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}
function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;")
}

// The formatted name + an optional data-fullname attr (present only when the preference shortened it).
function shape(raw: string, pref: NamePref): { formatted: string; dataAttr: string } {
  const full = decode(raw).trim()
  const formatted = formatName(full, pref)
  const dataAttr = formatted !== full ? ` data-fullname="${escapeAttr(full)}"` : ""
  return { formatted: escapeHtml(formatted), dataAttr }
}

/** Rewrite mention-pill + reply-quote author names in a message body per the Names preference. A
 *  `full` preference (or a name it doesn't shorten) leaves the body byte-identical. */
export function formatBodyNames(html: string, pref: NamePref): string {
  if (typeof html !== "string" || !html) return html
  let out = html.replace(MENTION_SPAN, (m, attrs, _q, inner) => {
    const raw = stripTags(inner).replace(/^@+/, "")
    if (!raw.trim()) return m
    const { formatted, dataAttr } = shape(raw, pref)
    return `<span${attrs}${dataAttr}>@${formatted}</span>`
  })
  out = out.replace(QUOTE_STRONG, (m, open, _q, gt, inner, close) => {
    const raw = stripTags(inner)
    if (!raw.trim()) return m
    const { formatted, dataAttr } = shape(raw, pref)
    return `${open}${dataAttr}${gt}${formatted}${close}`
  })
  return out
}
