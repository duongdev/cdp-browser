// Middle-elide long link text (PSN-99). A bare URL rendered as its own text wraps to several lines
// and truncates awkwardly; showing head…tail keeps the origin AND the tail (the meaningful id) on one
// line: "https://dev.azure.com/FWDGODev…pullrequest/156680".

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

const ELIDE_OVER = 48

/** Rewrite each `<a>` that DISPLAYS a URL to a middle-elided string built from the **href** (the full,
 *  clean URL) — never from the visible text, which Teams may have already shortened with its own "…"
 *  (re-eliding that gave a double ellipsis, PSN-99). The href stays intact + goes in `title`. Operates
 *  on ALREADY-SANITIZED html — only shortens anchor text nodes (auto-escaped), so no XSS surface. */
export function elideLinkText(html: string): string {
  if (typeof DOMParser === "undefined" || !html.includes("<a")) return html
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html")
  let changed = false
  for (const a of Array.from(doc.querySelectorAll("a[href]"))) {
    const txt = (a.textContent ?? "").trim()
    const href = a.getAttribute("href") ?? ""
    // Only when the anchor is SHOWING a URL (not a descriptive label) and the real URL is long.
    if (isUrlLike(txt) && href.length > ELIDE_OVER) {
      if (!a.getAttribute("title")) a.setAttribute("title", href)
      a.textContent = middleEllipsis(href)
      changed = true
    }
  }
  return changed ? doc.body.innerHTML : html
}
