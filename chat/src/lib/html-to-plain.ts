// Seed the inline message editor (t122): a message `body` is rich, site-authored HTML (t111), but the
// editor + the composer are plain-text only, so an edit starts from the body's visible text. Runs in
// the node test env (no DOM), so it's a pure string transform, not DOMParser.
//
// ponytail: naive regex HTML→text — line breaks from <br>/</p>/</li>, tags dropped, the common named
// entities decoded. Good enough to seed a plain-text edit of a chat body; swap for DOMParser if a
// faithful extraction of rich structure is ever needed.
export function htmlToPlain(html: string): string {
  if (!html) return ""
  return html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/\s*(p|div|li)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&") // decode last so &amp;lt; → &lt;, not <
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}
