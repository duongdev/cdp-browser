import { useEffect, useState } from "react"
import type { EmojiCatalog } from "./emoji-catalog"

// Module-level cache
let catalogPromise: Promise<EmojiCatalog> | null = null
let catalogGlyphMap: Map<string, string> | null = null

function loadCatalog(): Promise<EmojiCatalog> {
  if (!catalogPromise) {
    // chat app served at /chat/, static assets from chat/public/ land at /chat/<file>
    catalogPromise = fetch("/chat/teams-emoji.json")
      .then((r) => r.json() as Promise<EmojiCatalog>)
      .then((cat) => {
        catalogGlyphMap = new Map(cat.emoji.map((e) => [e.i, e.u]))
        return cat
      })
      .catch(() => {
        // Failed load retries on the next picker open instead of caching the failure.
        catalogPromise = null
        return { categories: [], emoji: [] }
      })
  }
  return catalogPromise
}

export function useEmojiCatalog(): EmojiCatalog | null {
  const [catalog, setCatalog] = useState<EmojiCatalog | null>(null)
  useEffect(() => {
    let cancelled = false
    loadCatalog().then((cat) => {
      if (!cancelled) setCatalog(cat)
    })
    return () => {
      cancelled = true
    }
  }, [])
  return catalog
}

/** Returns the catalog glyph for a key once loaded, or null before load */
export function getCatalogGlyph(key: string): string | null {
  return catalogGlyphMap?.get(key) ?? null
}
