// The XSS boundary for Teams message HTML (t111). Message `content` is site-authored HTML that the
// server keeps intact (mention-resolved) — so it MUST be sanitized here, in the renderer, before it
// ever reaches dangerouslySetInnerHTML. DOMPurify is browser-native (no jsdom), so this is the only
// place it can run. One configured, memoized instance; the hook is registered once.
import DOMPurify from "dompurify"

// Strict allowlist: inline formatting, links, code, lists, quotes, line breaks, mention/emoji nodes.
// Everything else (script/style/iframe/event handlers/unknown tags+attrs) is dropped by omission.
const ALLOWED_TAGS = [
  "b",
  "strong",
  "i",
  "em",
  "u",
  "s",
  "a",
  "code",
  "pre",
  "kbd",
  "ul",
  "ol",
  "li",
  "blockquote",
  "br",
  "p",
  "span",
  "img",
]
const ALLOWED_ATTR = ["href", "title", "class", "src", "alt"]

const SAFE_HREF = /^(https?:|mailto:)/i

let configured: typeof DOMPurify | null = null

function purifier(): typeof DOMPurify {
  if (configured) return configured
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") {
      // Force every surviving link to open safely; drop any href that isn't http(s)/mailto so a
      // scheme DOMPurify's default URI policy might tolerate can't ride through here.
      const href = node.getAttribute("href")
      if (href && !SAFE_HREF.test(href)) node.removeAttribute("href")
      node.setAttribute("target", "_blank")
      node.setAttribute("rel", "noopener noreferrer")
    }
    if (node.tagName === "IMG") node.setAttribute("loading", "lazy")
  })
  configured = DOMPurify
  return DOMPurify
}

/** Sanitize site-authored message HTML to a safe string. Always call this before assigning message
 *  HTML to the DOM — it is the single XSS boundary for the thread view. */
export function sanitize(html: string): string {
  return purifier().sanitize(html ?? "", { ALLOWED_TAGS, ALLOWED_ATTR, ALLOW_DATA_ATTR: false })
}
