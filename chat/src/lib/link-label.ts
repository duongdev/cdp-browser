// How a URL is DISPLAYED, in one place (PSN-104 steering). Human message bodies (sanitized HTML)
// and AI answers (streamed markdown) render through different pipelines but must label a link the
// same way, so the rule lives here and both call it.
//
// Two rules today:
//   - An Azure DevOps pull-request URL reads as its repo + number: "genai-…-webview#157145".
//   - Any other URL shown as its own text is middle-elided so the origin AND the tail stay on one
//     line (PSN-99).
// A link with a descriptive label is never touched — only ones displaying a raw URL.

/** Elide the middle of `s` to `head` + … + `tail` chars when it's longer than the budget. */
export function middleEllipsis(s: string, head = 30, tail = 16): string {
  if (s.length <= head + tail + 1) return s
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`
}

/** True when the visible link text is itself a URL — including one Teams already shortened with its
 *  own "…"/"..." (so we recognise it and re-render from the clean href instead of double-eliding). */
export function isUrlLike(text: string): boolean {
  return /^(https?:\/\/|www\.)\S+$/i.test(text.trim())
}

export interface AzurePr {
  repo: string
  id: string
}

/** `https://dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{id}` → `{repo, id}`.
 *  Also accepts the legacy `{org}.visualstudio.com` host. Anything else → null. */
export function parseAzurePr(href: string): AzurePr | null {
  const m =
    /^https?:\/\/(?:dev\.azure\.com|[^/]+\.visualstudio\.com)\/[^?#]*?\/_git\/([^/?#]+)\/pullrequest\/(\d+)/i.exec(
      href.trim(),
    )
  if (!m) return null
  return { repo: decodeURIComponent(m[1]), id: m[2] }
}

/** `https://<tenant>.atlassian.net/browse/<TICKET-KEY>` → ticket key string.
 *  Matches any tenant. Case-insensitive host, ticket key is upper-case by convention. */
export function parseJiraTicket(href: string): string | null {
  const m = /^https?:\/\/[^/]+\.atlassian\.net\/browse\/([A-Z][A-Z0-9]+-\d+)/i.exec(href.trim())
  return m ? m[1].toUpperCase() : null
}

const ELIDE_OVER = 48

/** The label a bare URL should DISPLAY. Returns null when the URL is short enough to show as-is. */
export function linkLabel(href: string): string | null {
  const pr = parseAzurePr(href)
  if (pr) return `${pr.repo}#${pr.id}`
  const jira = parseJiraTicket(href)
  if (jira) return jira
  return href.length > ELIDE_OVER ? middleEllipsis(href) : null
}

/** Rewrite each `<a>` that DISPLAYS a URL to `linkLabel`'s label, built from the **href** (the full,
 *  clean URL) — never from the visible text, which Teams may have already shortened with its own "…"
 *  (re-eliding that gave a double ellipsis, PSN-99). The href stays intact + goes in `title`.
 *  Every anchor (including descriptive ones) gets its href as the tooltip so hovering always shows
 *  the full URL. Operates on ALREADY-SANITIZED html — only shortens anchor text nodes (auto-escaped),
 *  so no XSS surface. */
export function elideLinkText(html: string): string {
  if (typeof DOMParser === "undefined" || !html.includes("<a")) return html
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html")
  let changed = false
  for (const a of Array.from(doc.querySelectorAll("a[href]"))) {
    const href = a.getAttribute("href") ?? ""
    // Always stamp the full URL as title so every link shows its destination on hover.
    if (!a.getAttribute("title")) {
      a.setAttribute("title", href)
      changed = true
    }
    const txt = (a.textContent ?? "").trim()
    // Only elide/chip when the anchor is SHOWING a URL (not a descriptive label).
    if (!isUrlLike(txt)) continue
    const label = linkLabel(href)
    if (!label) continue
    a.textContent = label
    changed = true
  }
  return changed ? doc.body.innerHTML : html
}

// Markdown links, for the AI answer path. Rewriting the SOURCE keeps Streamdown's own anchor
// instead of overriding its `a` renderer. ONE pass over "existing markdown link OR bare URL", in
// that alternation order, so the bare-URL branch can never fire on the href inside a link we just
// handled.
const MD_LINK_OR_URL_RE = /\[([^\]\n]*)\]\((<?)(https?:\/\/[^\s)]+)(>?)\)|https?:\/\/[^\s<>)\]]+/g

/** Label bare URLs in markdown the same way the HTML path labels anchors. Chips/elisions become the
 *  link TEXT; the href is untouched, so clicking still opens the full URL. */
export function labelMarkdownLinks(md: string): string {
  return (md || "").replace(
    MD_LINK_OR_URL_RE,
    (whole: string, text: string | undefined, lt: string, href: string, gt: string) => {
      if (href !== undefined) {
        const label = isUrlLike(text ?? "") ? linkLabel(href) : null
        return label ? `[${label}](${lt}${href}${gt})` : whole
      }
      // Bare URL — trailing sentence punctuation isn't part of it.
      const trail = /[.,;:!?]+$/.exec(whole)?.[0] ?? ""
      const clean = trail ? whole.slice(0, -trail.length) : whole
      const label = linkLabel(clean)
      return label ? `[${label}](${clean})${trail}` : whole
    },
  )
}
