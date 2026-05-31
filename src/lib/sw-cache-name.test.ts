import { describe, expect, it } from "vitest"
import { cacheNameFor, isStaleCache } from "./sw-cache-name"

describe("cacheNameFor", () => {
  it("composes version and sha", () => {
    expect(cacheNameFor("0.1.0", "ab12cd3")).toBe("cdp-portal-0.1.0-ab12cd3")
  })

  it("falls back to version only when sha is missing", () => {
    expect(cacheNameFor("0.1.0")).toBe("cdp-portal-0.1.0")
    expect(cacheNameFor("0.1.0", "")).toBe("cdp-portal-0.1.0")
  })

  it("never produces a bare cdp-portal- with no version", () => {
    // Empty version is a build misconfig, not a real input — still must not strand
    // every install on the same nameless cache.
    expect(cacheNameFor("")).toBe("cdp-portal-unknown")
    expect(cacheNameFor("", "ab12cd3")).toBe("cdp-portal-unknown-ab12cd3")
  })
})

describe("isStaleCache", () => {
  const current = "cdp-portal-0.1.0-ab12cd3"

  it("flags older cdp-portal-* caches", () => {
    expect(isStaleCache("cdp-portal-0.0.9-99zz000", current)).toBe(true)
    expect(isStaleCache("cdp-portal-v1", current)).toBe(true)
  })

  it("keeps the current cache", () => {
    expect(isStaleCache(current, current)).toBe(false)
  })

  it("ignores caches we do not own", () => {
    expect(isStaleCache("some-other-cache", current)).toBe(false)
    expect(isStaleCache("workbox-precache", current)).toBe(false)
  })
})
