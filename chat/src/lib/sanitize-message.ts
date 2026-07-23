// The XSS boundary for Teams message HTML (t133). Message `content` is site-authored HTML that the
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
  "video",
]
// `src`/`alt`/`class` for images; `itemtype`/`width`/`height` for the media-kind CSS selectors and
// natural sizing; `controls`/`data-duration` for AMS video (t139). The proxy src (same-origin
// `/api/teams/media?url=…`) and the public-CDN hosts pass DOMPurify's default URI policy unchanged.
const ALLOWED_ATTR = [
  "href",
  "title",
  "class",
  "src",
  "alt",
  "itemtype",
  "width",
  "height",
  "controls",
  "data-duration",
  // Full-name for the Names-setting hover tooltip on a shortened mention / quote author (PSN-92 E).
  "data-fullname",
  // The quoted message id on a reply blockquote — the click-to-jump target (PSN-92 B5).
  "data-reply-id",
]

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
    // Dark-mode carry-over guard (t151): strip any color-forcing attrs Teams ships on email-style /
    // quoted bodies so a hardcoded light background/text can't survive into dark mode. `style` is
    // already outside ALLOWED_ATTR (so DOMPurify drops it), but bgcolor/color are legacy presentational
    // attrs — remove them defensively; a CSS override in index.css is the second layer.
    for (const attr of ["style", "bgcolor", "color", "background"]) {
      if (node.hasAttribute?.(attr)) node.removeAttribute(attr)
    }
    if (node.tagName === "IMG") node.setAttribute("loading", "lazy")
    // AMS video arrives with no `controls` attr — force it so the clip is playable inline (t139).
    if (node.tagName === "VIDEO") {
      node.setAttribute("controls", "")
      node.setAttribute("preload", "metadata")
    }
  })
  configured = DOMPurify
  return DOMPurify
}

/** Sanitize site-authored message HTML to a safe string. Always call this before assigning message
 *  HTML to the DOM — it is the single XSS boundary for the thread view. */
export function sanitize(html: string): string {
  return purifier().sanitize(html ?? "", { ALLOWED_TAGS, ALLOWED_ATTR, ALLOW_DATA_ATTR: false })
}
