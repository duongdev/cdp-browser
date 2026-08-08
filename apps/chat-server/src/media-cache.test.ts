import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { cacheKey, MediaCache } from "./media-cache"

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "media-cache-test-"))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe("MediaCache", () => {
  it("returns null on a miss", () => {
    const cache = new MediaCache({ dir: tmpDir })
    expect(cache.get("nope")).toBeNull()
  })

  it("round-trips a set → get", () => {
    const cache = new MediaCache({ dir: tmpDir })
    const body = new Uint8Array([1, 2, 3, 4])
    cache.set("key1", body, "image/png")
    const got = cache.get("key1")
    expect(got).not.toBeNull()
    expect([...got!.body]).toEqual([1, 2, 3, 4])
    expect(got!.contentType).toBe("image/png")
  })

  it("survives a restart (index persisted)", () => {
    const cache1 = new MediaCache({ dir: tmpDir })
    cache1.set("key1", new Uint8Array([5, 6]), "image/jpeg")
    const cache2 = new MediaCache({ dir: tmpDir })
    const got = cache2.get("key1")
    expect(got).not.toBeNull()
    expect([...got!.body]).toEqual([5, 6])
    expect(got!.contentType).toBe("image/jpeg")
  })

  it("evicts oldest entries when over the size limit", () => {
    // maxBytes=5 → one 4-byte entry fits, the second evicts the first.
    const cache = new MediaCache({ dir: tmpDir, maxBytes: 5 })
    cache.set("a", new Uint8Array(4), "image/png")
    expect(cache.stats().entries).toBe(1)
    cache.set("b", new Uint8Array(4), "image/png")
    // 'a' was evicted (it was the oldest/only entry when 'b' pushed total to 8 > 5)
    expect(cache.get("a")).toBeNull()
    expect(cache.get("b")).not.toBeNull()
    expect(cache.stats().entries).toBe(1)
    expect(cache.stats().totalBytes).toBeLessThanOrEqual(5)
  })

  it("handles a missing file (stale index)", () => {
    const cache = new MediaCache({ dir: tmpDir })
    cache.set("key1", new Uint8Array([1]), "image/png")
    // Delete the file behind the cache's back
    const file = path.join(tmpDir, "key1.bin")
    fs.unlinkSync(file)
    expect(cache.get("key1")).toBeNull()
  })

  it("updates size on re-cache of same key", () => {
    const cache = new MediaCache({ dir: tmpDir })
    cache.set("key1", new Uint8Array(10), "image/png")
    expect(cache.stats().totalBytes).toBe(10)
    cache.set("key1", new Uint8Array(5), "image/png")
    expect(cache.stats().totalBytes).toBe(5)
  })

  it("degrades silently when dir is unwritable", () => {
    // Use a path that can't be created (under a file)
    const cache = new MediaCache({ dir: "/dev/null/impossible" })
    cache.set("key1", new Uint8Array([1]), "image/png")
    expect(cache.get("key1")).toBeNull()
  })
})

describe("cacheKey", () => {
  it("hashes a url to a hex string", () => {
    const key = cacheKey("https://example.com/v1/objects/abc/views/imgo")
    expect(key).toMatch(/^[0-9a-f]{32}$/)
  })

  it("produces different keys for different urls", () => {
    expect(cacheKey("https://a.com")).not.toBe(cacheKey("https://b.com"))
  })
})
