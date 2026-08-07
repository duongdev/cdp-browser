// Sent-image content builder for the Teams chat backend (t145, ADR-0019). An image pasted/picked in
// the composer is uploaded to Teams' AMS store (create object → PUT bytes, IN-PAGE), then posted as a
// RichText/Html message whose body is an AMSImage <img> pointing at the object's display view. This
// module is the pure builder for that body (the effectful upload/send live in web/server.mjs). The
// rendered src is the raw AMS host; the read path (core/teams-media.js:rewriteMediaHtml) rewrites it
// to the same-origin media proxy so the browser loads it authenticated. Tested by teams-ams.test.ts.

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

// Build the RichText/Html message content for an uploaded AMS image. The caption is prepended
// before the <img>; the img is tagged as an AMSImage (the `itemtype` the media rewrite/CSS keys on)
// and points at the `imgo` display view. Width/height are the image's natural dimensions — emitted
// only when both are positive so the box is reserved.
//
// `captionHtml` (t182) is the composer's pre-built rich body and wins over `caption` when present:
// it is inserted VERBATIM so @mention spans survive to the wire. `caption` remains the plain-text
// path and is HTML-escaped (newlines → <br>).
function buildAmsImageContent({ host, objId, width, height, caption, captionHtml } = {}) {
  const src = `${String(host).replace(/\/$/, "")}/v1/objects/${objId}/views/imgo`
  const w = Number(width) > 0 ? Math.round(Number(width)) : 0
  const h = Number(height) > 0 ? Math.round(Number(height)) : 0
  const dims = w && h ? ` width="${w}" height="${h}"` : ""
  const img = `<img itemtype="http://schema.skype.com/AMSImage" src="${src}" itemscope="itemscope"${dims}>`
  return captionPrefix(caption, captionHtml) + img
}

// The caption block that precedes uploaded media. Pre-built HTML wins verbatim (mention spans);
// otherwise plain text is escaped. Either way a trailing <br> separates it from the media.
function captionPrefix(caption, captionHtml) {
  if (captionHtml && String(captionHtml).trim()) return `${captionHtml}<br>`
  if (!caption || !String(caption).trim()) return ""
  return `${escapeHtml(caption).replace(/\n/g, "<br>")}<br>`
}

// Build the RichText/Html message content for multiple uploaded AMS images in a single message.
// Each image in `images` is `{ host, objId, width, height }`. The caption is prepended before the
// first image (see buildAmsImageContent for the caption/captionHtml split). Emits one <img> per
// image, separated by a <br>.
function buildAmsImageContentMulti(images, caption, captionHtml) {
  if (!images || images.length === 0) return ""
  const imgs = images
    .map(({ host, objId, width, height }) => {
      const src = `${String(host).replace(/\/$/, "")}/v1/objects/${objId}/views/imgo`
      const w = Number(width) > 0 ? Math.round(Number(width)) : 0
      const h = Number(height) > 0 ? Math.round(Number(height)) : 0
      const dims = w && h ? ` width="${w}" height="${h}"` : ""
      return `<img itemtype="http://schema.skype.com/AMSImage" src="${src}" itemscope="itemscope"${dims}>`
    })
    .join("<br>")
  return captionPrefix(caption, captionHtml) + imgs
}

module.exports = { buildAmsImageContent, buildAmsImageContentMulti, captionPrefix, escapeHtml }
