import { describe, expect, it } from "vitest"
// CommonJS module shared with web/server.mjs + main.js (which can't import src/lib ESM).
import {
  frecencyScore,
  isHistoryableUrl,
  rankHistory,
  recordVisit,
  visitsFromTabs,
} from "./history-store"

const HOUR = 3600_000
const DAY = 24 * HOUR

describe("recordVisit", () => {
  it("adds a new visit with visitCount 1", () => {
    const out = recordVisit([], { url: "https://a.com/", title: "A", ts: 1000 })
    expect(out).toEqual([{ url: "https://a.com/", title: "A", visitCount: 1, lastVisit: 1000 }])
  })

  it("dedups by url — bumps visitCount and lastVisit, keeps latest title", () => {
    let v = recordVisit([], { url: "https://a.com/", title: "Old", ts: 1000 })
    v = recordVisit(v, { url: "https://a.com/", title: "New", ts: 2000 })
    expect(v).toEqual([{ url: "https://a.com/", title: "New", visitCount: 2, lastVisit: 2000 }])
  })

  it("keeps the existing title when the new visit has none", () => {
    let v = recordVisit([], { url: "https://a.com/", title: "Kept", ts: 1000 })
    v = recordVisit(v, { url: "https://a.com/", title: "", ts: 2000 })
    expect(v[0].title).toBe("Kept")
  })

  it("falls back to the url as title for a titleless new url", () => {
    const v = recordVisit([], { url: "https://a.com/", title: "", ts: 1000 })
    expect(v[0].title).toBe("https://a.com/")
  })

  it("does not mutate the input array", () => {
    const orig = [{ url: "https://a.com/", title: "A", visitCount: 1, lastVisit: 1000 }]
    const copy = JSON.parse(JSON.stringify(orig))
    recordVisit(orig, { url: "https://b.com/", title: "B", ts: 2000 })
    expect(orig).toEqual(copy)
  })

  it("caps the store, dropping the lowest-frecency entries", () => {
    let v: unknown[] = []
    // three low-count old visits + one fresh — cap to 2 keeps the fresh + highest.
    v = recordVisit(v, { url: "https://old1/", title: "", ts: 0 })
    v = recordVisit(v, { url: "https://old2/", title: "", ts: 0 })
    v = recordVisit(
      v,
      { url: "https://fresh/", title: "", ts: 10 * DAY },
      { cap: 2, now: 10 * DAY },
    )
    expect(v).toHaveLength(2)
    expect(v.some((e: any) => e.url === "https://fresh/")).toBe(true)
  })
})

describe("frecencyScore", () => {
  it("rewards more visits", () => {
    const now = 10 * DAY
    const a = frecencyScore({ url: "a", title: "", visitCount: 5, lastVisit: now }, now)
    const b = frecencyScore({ url: "b", title: "", visitCount: 1, lastVisit: now }, now)
    expect(a).toBeGreaterThan(b)
  })

  it("rewards recency — a fresh single visit beats an ancient one", () => {
    const now = 100 * DAY
    const fresh = frecencyScore({ url: "a", title: "", visitCount: 1, lastVisit: now }, now)
    const old = frecencyScore({ url: "b", title: "", visitCount: 1, lastVisit: 0 }, now)
    expect(fresh).toBeGreaterThan(old)
  })
})

describe("rankHistory", () => {
  const now = 10 * DAY
  const visits = [
    { url: "https://github.com/", title: "GitHub", visitCount: 10, lastVisit: now },
    { url: "https://google.com/", title: "Google", visitCount: 1, lastVisit: now - 5 * DAY },
    { url: "https://gitlab.com/", title: "GitLab", visitCount: 3, lastVisit: now - DAY },
  ]

  it("empty query ranks by frecency desc", () => {
    const out = rankHistory(visits, { query: "", now, limit: 10 })
    expect(out[0].url).toBe("https://github.com/")
  })

  it("matches on url", () => {
    const out = rankHistory(visits, { query: "gitlab", now, limit: 10 })
    expect(out.map((v) => v.url)).toEqual(["https://gitlab.com/"])
  })

  it("matches on title", () => {
    const out = rankHistory(visits, { query: "google", now, limit: 10 })
    expect(out.map((v) => v.url)).toEqual(["https://google.com/"])
  })

  it("is diacritic-insensitive", () => {
    const v = [{ url: "https://x/", title: "Đà Nẵng", visitCount: 1, lastVisit: now }]
    expect(rankHistory(v, { query: "da nang", now, limit: 10 })).toHaveLength(1)
  })

  it("respects the limit", () => {
    const out = rankHistory(visits, { query: "git", now, limit: 1 })
    expect(out).toHaveLength(1)
  })
})

describe("visitsFromTabs", () => {
  it("emits a visit for each newly-seen tab url", () => {
    const { changed, next } = visitsFromTabs({}, [
      { id: "1", url: "https://a.com/", title: "A" },
      { id: "2", url: "https://b.com/", title: "B" },
    ])
    expect(changed).toEqual([
      { url: "https://a.com/", title: "A" },
      { url: "https://b.com/", title: "B" },
    ])
    expect(next).toEqual({ "1": "https://a.com/", "2": "https://b.com/" })
  })

  it("ignores tabs whose url is unchanged", () => {
    const prev = { "1": "https://a.com/" }
    const { changed } = visitsFromTabs(prev, [{ id: "1", url: "https://a.com/", title: "A" }])
    expect(changed).toEqual([])
  })

  it("emits when a tab navigates to a new url", () => {
    const prev = { "1": "https://a.com/" }
    const { changed } = visitsFromTabs(prev, [{ id: "1", url: "https://a.com/next", title: "A2" }])
    expect(changed).toEqual([{ url: "https://a.com/next", title: "A2" }])
  })

  it("skips non-historyable urls", () => {
    const { changed } = visitsFromTabs({}, [
      { id: "1", url: "about:blank", title: "" },
      { id: "2", url: "https://ok.com/", title: "OK" },
    ])
    expect(changed).toEqual([{ url: "https://ok.com/", title: "OK" }])
  })
})

describe("isHistoryableUrl", () => {
  it("accepts http and https", () => {
    expect(isHistoryableUrl("https://a.com/")).toBe(true)
    expect(isHistoryableUrl("http://a.com/")).toBe(true)
  })

  it("rejects blank / internal / non-http schemes", () => {
    for (const u of ["", "about:blank", "chrome://newtab", "edge://settings", "devtools://x"]) {
      expect(isHistoryableUrl(u)).toBe(false)
    }
  })
})
