import { describe, expect, it } from "vitest"
import { fromPersisted, type LocalTab, sortPinnedFirst, toPersisted } from "./local-tabs"

const tab = (over: Partial<LocalTab> = {}): LocalTab => ({
  id: "l1",
  url: "https://example.com",
  title: "Example",
  pinned: false,
  loading: false,
  canGoBack: false,
  canGoForward: false,
  audible: false,
  muted: false,
  ...over,
})

describe("sortPinnedFirst", () => {
  it("puts pinned tabs first, preserving relative order within each group", () => {
    const tabs = [
      tab({ id: "a", pinned: false }),
      tab({ id: "b", pinned: true }),
      tab({ id: "c", pinned: false }),
      tab({ id: "d", pinned: true }),
    ]
    expect(sortPinnedFirst(tabs).map((t) => t.id)).toEqual(["b", "d", "a", "c"])
  })

  it("returns the same reference when already ordered (no needless churn)", () => {
    const tabs = [tab({ id: "a", pinned: true }), tab({ id: "b", pinned: false })]
    expect(sortPinnedFirst(tabs)).toBe(tabs)
  })
})

describe("toPersisted", () => {
  it("keeps all open tabs (pinned or not) and strips live-only fields", () => {
    const tabs = [
      tab({ id: "a", pinned: true, url: "https://example.com", title: "Example", loading: true }),
      tab({ id: "b", pinned: false, url: "https://x.com", title: "X" }),
    ]
    expect(toPersisted(tabs)).toEqual([
      { id: "a", url: "https://example.com", title: "Example", favicon: undefined, pinned: true },
      { id: "b", url: "https://x.com", title: "X", favicon: undefined, pinned: false },
    ])
  })
})

describe("fromPersisted", () => {
  it("hydrates saved tabs preserving the pinned flag, with inert live defaults", () => {
    const result = fromPersisted([
      { id: "a", url: "https://example.com", title: "Example", pinned: true },
      { id: "b", url: "https://x.com", title: "X", pinned: false },
    ])
    expect(result).toEqual([
      tab({ id: "a", url: "https://example.com", title: "Example", pinned: true }),
      tab({ id: "b", url: "https://x.com", title: "X", pinned: false }),
    ])
  })
})
