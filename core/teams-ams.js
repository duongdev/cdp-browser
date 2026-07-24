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

// Build the RichText/Html message content for an uploaded AMS image. The optional caption is
// HTML-escaped (newlines → <br>) and prepended before the <img>; the img is tagged as an AMSImage
// (the `itemtype` the media rewrite/CSS keys on) and points at the `imgo` display view. Width/height
// are the image's natural dimensions — emitted only when both are positive so the box is reserved.
function buildAmsImageContent({ host, objId, width, height, caption } = {}) {
  const src = `${String(host).replace(/\/$/, "")}/v1/objects/${objId}/views/imgo`
  const w = Number(width) > 0 ? Math.round(Number(width)) : 0
  const h = Number(height) > 0 ? Math.round(Number(height)) : 0
  const dims = w && h ? ` width="${w}" height="${h}"` : ""
  const img = `<img itemtype="http://schema.skype.com/AMSImage" src="${src}" itemscope="itemscope"${dims}>`
  const cap =
    caption && String(caption).trim() ? `${escapeHtml(caption).replace(/\n/g, "<br>")}<br>` : ""
  return cap + img
}

// Build the RichText/Html message content for multiple uploaded AMS images in a single message.
// Each image in `images` is `{ host, objId, width, height }`. The optional caption is prepended
// before the first image (HTML-escaped). Emits one <img> per image, separated by a <br>.
function buildAmsImageContentMulti(images, caption) {
  if (!images || images.length === 0) return ""
  const cap =
    caption && String(caption).trim() ? `${escapeHtml(caption).replace(/\n/g, "<br>")}<br>` : ""
  const imgs = images
    .map(({ host, objId, width, height }) => {
      const src = `${String(host).replace(/\/$/, "")}/v1/objects/${objId}/views/imgo`
      const w = Number(width) > 0 ? Math.round(Number(width)) : 0
      const h = Number(height) > 0 ? Math.round(Number(height)) : 0
      const dims = w && h ? ` width="${w}" height="${h}"` : ""
      return `<img itemtype="http://schema.skype.com/AMSImage" src="${src}" itemscope="itemscope"${dims}>`
    })
    .join("<br>")
  return cap + imgs
}

module.exports = { buildAmsImageContent, buildAmsImageContentMulti, escapeHtml }
