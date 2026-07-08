import { describe, expect, it } from "vitest"
import { suggest } from "./tab-suggest"

const now = 10 * 24 * 3600_000
const history = [
  { url: "https://github.com/", title: "GitHub", visitCount: 10, lastVisit: now },
  { url: "https://gitlab.com/", title: "GitLab", visitCount: 2, lastVisit: now },
  { url: "https://google.com/", title: "Google Search", visitCount: 1, lastVisit: now },
]
const openTabs = [
  {
    kind: "cdp" as const,
    id: "t1",
    title: "GitHub — Pull requests",
    url: "https://github.com/pulls",
  },
  { kind: "local" as const, id: "l1", title: "Localhost", url: "http://localhost:3000/" },
]

describe("suggest", () => {
  it("returns nothing for an empty query (pins own the empty state)", () => {
    expect(suggest({ query: "", history, openTabs, now, limit: 10 })).toEqual([])
  })

  it("puts matching open tabs first as switch rows", () => {
    const out = suggest({ query: "github", history, openTabs, now, limit: 10 })
    expect(out[0]).toEqual({
      kind: "switch",
      tabKind: "cdp",
      id: "t1",
      title: "GitHub — Pull requests",
      url: "https://github.com/pulls",
    })
  })

  it("matches history on title and url, ranked by frecency", () => {
    const out = suggest({ query: "git", history, openTabs: [], now, limit: 10 })
    expect(out.map((s) => (s.kind === "history" ? s.url : ""))).toEqual([
      "https://github.com/",
      "https://gitlab.com/",
    ])
  })

  it("dedups a history url that is already an open tab", () => {
    const out = suggest({
      query: "github.com",
      history: [{ url: "https://github.com/pulls", title: "PRs", visitCount: 5, lastVisit: now }],
      openTabs,
      now,
      limit: 10,
    })
    // the open tab https://github.com/pulls wins as a switch row; no dup history row
    expect(out.filter((s) => s.url === "https://github.com/pulls")).toHaveLength(1)
    expect(out[0].kind).toBe("switch")
  })

  it("is diacritic-insensitive", () => {
    const out = suggest({
      query: "da nang",
      history: [{ url: "https://x/", title: "Đà Nẵng", visitCount: 1, lastVisit: now }],
      openTabs: [],
      now,
      limit: 10,
    })
    expect(out).toHaveLength(1)
  })

  it("respects the limit across switches + history", () => {
    const out = suggest({ query: "git", history, openTabs, now, limit: 1 })
    expect(out).toHaveLength(1)
  })
})
