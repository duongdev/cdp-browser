// AMS media SSRF gate + HTML rewrite for the Teams chat backend (t117, ADR-0018). Teams inline
// media (images/video) is hosted on AMS (`as-*.asm.skype.com`, `*.asyncgw.teams.microsoft.com`)
// and 401s from a server-side or `mode:'no-cors'` fetch — it loads ONLY from an IN-PAGE fetch with
// the `Authentication: skypetoken=…` header. So `/api/teams/media` proxies through the side-channel
// (CA-proof, like teamsHistory). This module is the single gate + rewrite: only an https AMS object
// URL is ever handed to the in-page fetch, so a garbled/hostile `src` can't steer it at another host
// (skypetoken exfiltration / SSRF). Pure — no I/O, no DOM. Tested by teams-media.test.ts.

// SSRF gate: an https URL whose host is `*.asm.skype.com` or `*.asyncgw.teams.microsoft.com` and
// whose path is an AMS object (`/v1/objects/…`). The URL parser yields the real host, so `@`/`.`
// look-alikes (`base.evil.com`, `base@evil.com`) resolve to their true authority and fail the
// suffix. Public-CDN media (giphy, statics.teams.cdn.office.net) is not AMS — it needs no auth and
// is left to load directly, so it must NOT pass this gate.
function isValidAmsUrl(url) {
  if (typeof url !== "string" || !url) return false
  let u
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol !== "https:") return false
  const h = u.hostname
  const amsHost = h.endsWith(".asm.skype.com") || h.endsWith(".asyncgw.teams.microsoft.com")
  if (!amsHost) return false
  return u.pathname.startsWith("/v1/objects/")
}

// The immutable object id from an AMS url (`/v1/objects/{id}/views/…`), or null. The id is the
// stable cache key — a view of one object never changes.
function amsObjectId(url) {
  try {
    const m = new URL(url).pathname.match(/^\/v1\/objects\/([^/]+)/)
    return m ? decodeURIComponent(m[1]) : null
  } catch {
    return null
  }
}

const TAG_RE = /<(?:img|video)\b[^>]*>/gi
const SRC_RE = /(\bsrc\s*=\s*)(["'])([\s\S]*?)\2/i

// Rewrite `<img>`/`<video>` tags whose `src` is an AMS object URL to point at the same-origin proxy
// (`/api/teams/media?url=…`), so the client loads authenticated media through the CA-proof endpoint
// and the browser caches it normally (no giant data URLs in the DOM). Public-CDN and malformed srcs
// are left untouched. The AMS src is HTML-entity-decoded before validation/encoding so a query-param
// `&amp;` round-trips as a real `&`.
function rewriteMediaHtml(html) {
  if (typeof html !== "string" || !html) return html
  const rewritten = html.replace(TAG_RE, (tag) =>
    tag.replace(SRC_RE, (full, pre, q, raw) => {
      const decoded = raw.replace(/&amp;/g, "&")
      if (!isValidAmsUrl(decoded)) return full
      return `${pre}${q}/api/teams/media?url=${encodeURIComponent(decoded)}${q}`
    }),
  )
  return ensureMediaDimensions(rewritten)
}

// Reserve a media element's box before its bytes load (t118). Some AMS `<img>`/`<video>` carry NO
// width/height ATTRS — the size lives in inline `style="width:Npx; height:Npx"` (which DOMPurify
// strips), so the box renders at height 0 and jumps on load → scroll flicker. Convert those px dims
// to real width/height attrs (which survive the sanitizer) so the browser derives the aspect-ratio
// box up front. Tags that already have either attr, or that have no px style dims, are untouched.
// The lookbehind excludes max-width/min-height etc. from matching the real dimension.
// ponytail: `properties.blurHash` also exists on Teams media if a real blur placeholder is ever
// wanted; the reserved muted box is the accepted-for-now stand-in.
function ensureMediaDimensions(html) {
  if (typeof html !== "string" || !html) return html
  return html.replace(TAG_RE, (tag) => {
    if (/\bwidth\s*=/i.test(tag) || /\bheight\s*=/i.test(tag)) return tag
    const style = tag.match(/\bstyle\s*=\s*(["'])([\s\S]*?)\1/i)
    if (!style) return tag
    const w = style[2].match(/(?<![-\w])width\s*:\s*([\d.]+)px/i)
    const h = style[2].match(/(?<![-\w])height\s*:\s*([\d.]+)px/i)
    if (!w || !h) return tag
    return tag.replace(
      /^<(img|video)\b/i,
      (_m, name) => `<${name} width="${w[1]}" height="${h[1]}"`,
    )
  })
}

module.exports = { isValidAmsUrl, amsObjectId, rewriteMediaHtml, ensureMediaDimensions }
