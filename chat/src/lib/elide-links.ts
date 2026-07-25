// Middle-elide long link text (PSN-99). A bare URL rendered as its own text wraps to several lines
// and truncates awkwardly; showing head…tail keeps the origin AND the tail (the meaningful id) on one
// line: "https://dev.azure.com/FWDGODev…pullrequest/156680".

/** Elide the middle of `s` to `head` + … + `tail` chars when it's longer than the budget. */
export function middleEllipsis(s: string, head = 30, tail = 16): string {
  if (s.length <= head + tail + 1) return s
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`
}

/** True when the visible link text is itself a URL (so eliding it loses nothing a label would carry). */
export function isUrlLike(text: string): boolean {
  return /^(https?:\/\/|www\.)\S+$/i.test(text.trim())
}

const ELIDE_OVER = 48

/** Rewrite each `<a>` whose visible text is a long URL to a middle-elided string, preserving the href
 *  and stashing the full URL in `title`. Operates on ALREADY-SANITIZED html — it only shortens text
 *  nodes of existing anchors (textContent assignment auto-escapes), so it adds no XSS surface. */
export function elideLinkText(html: string): string {
  if (typeof DOMParser === "undefined" || !html.includes("<a")) return html
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html")
  let changed = false
  for (const a of Array.from(doc.querySelectorAll("a[href]"))) {
    const txt = a.textContent ?? ""
    if (txt.length > ELIDE_OVER && isUrlLike(txt)) {
      if (!a.getAttribute("title")) a.setAttribute("title", txt)
      a.textContent = middleEllipsis(txt)
      changed = true
    }
  }
  return changed ? doc.body.innerHTML : html
}
