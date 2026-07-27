// Inline-image extraction for the assistant's vision path (PSN-104). A rendered message body holds
// its AMS images as `<img src="/api/chat/media?service=…&url=<ams>">` (rewritten upstream by
// core/teams-media.js). This module pulls those back out so an image can be captioned once at
// ingest and re-fetched on demand for a vision model.
//
// AMS objects ONLY (grilled): emoji, stickers and Giphy load straight from a public CDN, so they
// never carry the proxy `src` this matches — the filter is structural, not a denylist.
// Pure — no I/O, no DB. Tested by media-images.test.ts.

import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const { isValidAmsUrl, amsObjectId } = require("../../../core/teams-media.js") as {
  isValidAmsUrl: (url: string) => boolean
  amsObjectId: (url: string) => string | null
}

export { amsObjectId }

export interface MessageImage {
  /** The AMS object URL (decoded) — what `provider.media` fetches. */
  url: string
  /** Stable, immutable id for the object; the caption cache key. */
  objectId: string
  /** Position within the message, 1-based — what `view_image`'s `index` refers to. */
  index: number
}

const IMG_RE = /<img\b[^>]*>/gi
const SRC_RE = /\bsrc\s*=\s*(["'])([\s\S]*?)\1/i

/** Every AMS image in a rendered body, in document order. A body with none returns []. */
export function extractImages(body: string): MessageImage[] {
  if (typeof body !== "string" || !body) return []
  const out: MessageImage[] = []
  for (const tag of body.match(IMG_RE) || []) {
    const src = SRC_RE.exec(tag)?.[2]
    if (!src) continue
    const url = amsUrlFromSrc(src)
    if (!url) continue
    const objectId = amsObjectId(url)
    if (!objectId) continue
    out.push({ url, objectId, index: out.length + 1 })
  }
  return out
}

/** The AMS url behind a proxied `src` (`/api/chat/media?…&url=…`), or a bare AMS url if the body
 *  was never rewritten. Anything else (public CDN, data:, garbage) → null. */
export function amsUrlFromSrc(src: string): string | null {
  const decoded = (src || "").replace(/&amp;/g, "&")
  let candidate = decoded
  if (decoded.includes("/api/") && decoded.includes("url=")) {
    // Relative — a base is required to parse, and is thrown away with the rest of the URL.
    const param = new URL(decoded, "http://x").searchParams.get("url")
    if (!param) return null
    candidate = param
  }
  return isValidAmsUrl(candidate) ? candidate : null
}

/** The captioning instruction (grilled: verbatim transcription first, no length cap — work
 *  screenshots are mostly text, and that text is what makes them findable). */
export const CAPTION_PROMPT = [
  "Transcribe this image for a searchable chat archive.",
  "First, transcribe ALL visible text verbatim — error messages, code, ticket ids, names, numbers, UI labels — preserving the reading order. Do not summarise, truncate or translate it.",
  "Then add one short line describing what the image is (a screenshot of X, a photo of Y).",
  "If the image contains no text, describe it in two or three sentences instead.",
  "Output plain text only: no markdown fences, no preamble.",
].join("\n")
