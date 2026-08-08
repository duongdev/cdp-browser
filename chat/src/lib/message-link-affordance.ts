// Message-link affordance (t183). A message link resolves to an in-app jump instead of leaving for
// the Teams web client, so it must not look identical to an external link — the user cannot predict
// a click that silently diverges from normal anchor behaviour.
//
// This runs AFTER sanitize (the XSS boundary) and only sets a class on anchors whose href already
// resolves via `parseMessageUrl`; it never introduces markup or rewrites an href.

import { parseMessageUrl } from "./message-url"

/** Class stamped on an anchor that will jump inside the app rather than navigate away. */
export const IN_APP_LINK_CLASS = "msg-link"

/**
 * Tag every anchor in `html` that points at a resolvable message, so CSS can give it an in-app
 * affordance. Returns the HTML unchanged when nothing resolves (the common case), so the DOM
 * round-trip is skipped entirely for ordinary messages.
 */
export function markMessageLinks(html: string, origin: string): string {
  if (!html.includes("<a")) return html
  const doc = new DOMParser().parseFromString(html, "text/html")
  let touched = false
  for (const a of doc.querySelectorAll("a[href]")) {
    const target = parseMessageUrl(a.getAttribute("href") || "", origin)
    if (!target) continue
    a.classList.add(IN_APP_LINK_CLASS)
    // Tell the user where it goes before they click; the visual treatment alone can't say "message".
    if (!a.hasAttribute("title")) a.setAttribute("title", "Open this message in Chats")
    touched = true
  }
  return touched ? doc.body.innerHTML : html
}
