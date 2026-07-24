export interface CatalogEntry {
  i: string
  u: string
  d: string
  k: string
  c: number
}
export interface EmojiCatalog {
  categories: string[]
  emoji: CatalogEntry[]
}

/** Case-insensitive filter across d, k, i fields */
export function filterEmoji(emoji: CatalogEntry[], query: string): CatalogEntry[] {
  if (!query) return emoji
  const q = query.toLowerCase()
  return emoji.filter(
    (e) =>
      e.d.toLowerCase().includes(q) ||
      e.k.toLowerCase().includes(q) ||
      e.i.toLowerCase().includes(q),
  )
}

/** Group entries by category index, preserving insertion order within each group */
export function groupByCategory(emoji: CatalogEntry[]): Map<number, CatalogEntry[]> {
  const map = new Map<number, CatalogEntry[]>()
  for (const e of emoji) {
    const arr = map.get(e.c)
    if (arr) arr.push(e)
    else map.set(e.c, [e])
  }
  return map
}
