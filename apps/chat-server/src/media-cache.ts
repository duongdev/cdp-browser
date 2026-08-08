// Disk LRU cache for proxied AMS media (t185). AMS objects are immutable (the object id never
// changes content), so they cache safely with no invalidation. The first request fetches through
// the provider; every later request serves from disk — no CDP side-channel round-trip, no flicker
// on re-render. A size limit with LRU eviction keeps the cache bounded; the index is an append-only
// JSON file persisted on each write and eviction.
//
// The cache key is the AMS object id (extracted by `amsObjectId`), not the raw URL — a view of one
// object (`/views/imgo`, `/views/video`) shares the same id, and one object's bytes are one object's
// bytes regardless of which view the client requested. When the same object is fetched under different
// view paths, the first one wins; views are not independently cached.

import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

export interface CacheEntry {
  size: number
  contentType: string
  lastAccess: number
}

export interface MediaCacheOptions {
  /** Cache directory. Created on first write if missing. */
  dir: string
  /** Max total bytes. Default 500MB. */
  maxBytes?: number
}

export class MediaCache {
  private dir: string
  private maxBytes: number
  private index: Map<string, CacheEntry>
  private totalBytes: number
  private indexDirty = false

  constructor(opts: MediaCacheOptions) {
    this.dir = opts.dir
    this.maxBytes = opts.maxBytes ?? 500 * 1024 * 1024
    this.index = new Map()
    this.totalBytes = 0
    this.loadIndex()
  }

  private get indexPath() {
    return path.join(this.dir, "cache-index.json")
  }

  private entryPath(key: string) {
    return path.join(this.dir, `${key}.bin`)
  }

  private loadIndex() {
    try {
      const raw = fs.readFileSync(this.indexPath, "utf8")
      const data = JSON.parse(raw) as Record<string, CacheEntry>
      let total = 0
      for (const [key, entry] of Object.entries(data)) {
        this.index.set(key, entry)
        total += entry.size
      }
      this.totalBytes = total
    } catch {
      // missing or corrupt index — start empty (the cache dir may still have stale files, but
      // they are invisible until re-cached; a sweep is not worth the complexity for a warm-up).
    }
  }

  private persistIndex() {
    if (!this.indexDirty) return
    try {
      const obj: Record<string, CacheEntry> = {}
      for (const [key, entry] of this.index) obj[key] = entry
      fs.writeFileSync(this.indexPath, JSON.stringify(obj))
      this.indexDirty = false
    } catch {
      // best-effort — a read-only dir degrades to no-persist (still serves from memory).
    }
  }

  /** Read a cached entry. Returns null on miss (including when the file vanished from disk). */
  get(key: string): { body: Uint8Array; contentType: string } | null {
    const entry = this.index.get(key)
    if (!entry) return null
    try {
      const body = fs.readFileSync(this.entryPath(key))
      entry.lastAccess = Date.now()
      this.indexDirty = true
      this.persistIndex()
      return { body: new Uint8Array(body), contentType: entry.contentType }
    } catch {
      // file missing despite index entry — evict silently
      this.index.delete(key)
      this.totalBytes -= entry.size
      this.indexDirty = true
      this.persistIndex()
      return null
    }
  }

  /** Write an entry and evict LRU if over the limit. */
  set(key: string, body: Uint8Array, contentType: string) {
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      fs.writeFileSync(this.entryPath(key), body)
    } catch {
      return // unwritable dir — skip caching silently
    }
    // If the key already exists (re-cache of same object under a different view), subtract old size.
    const existing = this.index.get(key)
    if (existing) this.totalBytes -= existing.size

    this.index.set(key, {
      size: body.byteLength,
      contentType,
      lastAccess: Date.now(),
    })
    this.totalBytes += body.byteLength
    this.indexDirty = true

    this.evict()
    this.persistIndex()
  }

  /** Remove oldest entries until totalBytes ≤ maxBytes. */
  private evict() {
    if (this.totalBytes <= this.maxBytes) return
    const entries = [...this.index.entries()].sort((a, b) => a[1].lastAccess - b[1].lastAccess)
    for (const [key, entry] of entries) {
      if (this.totalBytes <= this.maxBytes) break
      try {
        fs.unlinkSync(this.entryPath(key))
      } catch {
        // already gone — fine
      }
      this.index.delete(key)
      this.totalBytes -= entry.size
      this.indexDirty = true
    }
  }

  /** Stats for diagnostics. */
  stats() {
    return {
      entries: this.index.size,
      totalBytes: this.totalBytes,
      maxBytes: this.maxBytes,
    }
  }
}

/** Hash a raw URL to a safe filename key. */
export function cacheKey(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 32)
}
