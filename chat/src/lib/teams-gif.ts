// GIF + sticker send for the composer (PSN-94 D/E). Both ride Giphy (gifs + transparent stickers)
// and the SAME native Teams wire schema — proven live 2026-07-25: a `RichText/Html` message with an
// `<img itemtype="http://schema.skype.com/AnimatedImage">` on the public Giphy CDN is accepted and
// normalized by Teams (it rewrites the id to `x_{id}` — how Teams stamps its own Giphy sends), so it
// round-trips as an animated GIF in the native client. Giphy media is public-CDN, so it needs no AMS
// proxy. A picked GIF is a DIRECT send (never through the contenteditable — `cleanEditorHtml` strips
// `<img>`), so it's shaped straight into an OutgoingMessage the parent's onSend already handles.
import type { OutgoingMessage } from "./rich-compose"

/** Giphy content class — GIFs or transparent stickers (same wire schema, different catalog). */
export type GiphyKind = "gifs" | "stickers"

export interface GifItem {
  id: string
  /** The original giphy.gif — what is sent + what animates in every client. */
  url: string
  /** A smaller still/animated preview for the picker grid. */
  previewUrl: string
  width: number
  height: number
}

const esc = (s: string): string =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")

/** The native Teams GIF wire body: an AnimatedImage `<img>` on the Giphy CDN wrapped in a span. */
export function buildGifContent(item: GifItem): string {
  const w = Number.isFinite(item.width) && item.width > 0 ? Math.round(item.width) : 220
  const h = Number.isFinite(item.height) && item.height > 0 ? Math.round(item.height) : 220
  return `<span><img itemscope="" itemtype="http://schema.skype.com/AnimatedImage" src="${esc(item.url)}" id="${esc(item.id)}" width="${w}" height="${h}"></span>`
}

/** A picked GIF/sticker as the OutgoingMessage the composer hands to onSend: RichText/Html body, the
 *  same body for the optimistic bubble, no text, no mentions. */
export function gifToOutgoing(item: GifItem): OutgoingMessage {
  const html = buildGifContent(item)
  return { text: "", html, displayHtml: html, mentions: [] }
}

/** Shape a Giphy API `data[]` entry into a GifItem. Defensive: a missing original url → null. */
export function giphyEntryToItem(g: {
  id?: string
  images?: { original?: Record<string, string>; fixed_width?: Record<string, string> }
}): GifItem | null {
  const orig = g.images?.original
  const url = orig?.url
  if (!g.id || !url) return null
  const prev = g.images?.fixed_width ?? orig ?? {}
  return {
    id: g.id,
    url,
    previewUrl: prev.url ?? url,
    width: Number(orig?.width) || 220,
    height: Number(orig?.height) || 220,
  }
}

/** Search Giphy through the BFF proxy (the API key lives server-side). Empty query → trending.
 *  Returns [] on any error — the picker shows its empty state rather than throwing. */
export async function searchGiphy(
  kind: GiphyKind,
  q: string,
  signal?: AbortSignal,
): Promise<GifItem[]> {
  try {
    const res = await fetch(
      `/api/chat/giphy?service=teams&kind=${kind}&q=${encodeURIComponent(q)}`,
      { signal },
    )
    if (!res.ok) return []
    const data = (await res.json().catch(() => ({}))) as { items?: GifItem[] }
    return Array.isArray(data.items) ? data.items : []
  } catch {
    return []
  }
}
