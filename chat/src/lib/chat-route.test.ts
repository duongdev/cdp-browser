import { describe, expect, it } from "vitest"
import { isSearchPath, parsePath, parseSearchUrlState, pathFor, pathForSearch } from "./chat-route"

const CONV = "19:abc123@thread.v2"

describe("parsePath", () => {
  it("returns null for the list path", () => {
    expect(parsePath("/chat/")).toBeNull()
    expect(parsePath("/chat")).toBeNull()
  })

  it("returns null for an unrelated path", () => {
    expect(parsePath("/")).toBeNull()
    expect(parsePath("/chat/settings")).toBeNull()
  })

  it("returns null for the search path (handled by isSearchPath)", () => {
    expect(parsePath("/chat/search")).toBeNull()
  })

  it("decodes an encoded conversation id", () => {
    expect(parsePath(`/chat/c/${encodeURIComponent(CONV)}`)).toEqual({ convId: CONV })
  })

  it("returns null for an empty id", () => {
    expect(parsePath("/chat/c/")).toBeNull()
  })

  it("returns null for a malformed percent-encoding", () => {
    expect(parsePath("/chat/c/%")).toBeNull()
  })
})

describe("pathFor", () => {
  it("encodes a conversation id", () => {
    expect(pathFor(CONV)).toBe(`/chat/c/${encodeURIComponent(CONV)}`)
  })

  it("returns the list path for null", () => {
    expect(pathFor(null)).toBe("/chat/")
  })

  it("round-trips through parsePath", () => {
    expect(parsePath(pathFor(CONV))).toEqual({ convId: CONV })
  })
})

describe("isSearchPath / pathForSearch", () => {
  it("matches the exact search path", () => {
    expect(isSearchPath("/chat/search")).toBe(true)
  })

  it("rejects sub-paths and the bare prefix", () => {
    expect(isSearchPath("/chat/search/")).toBe(false)
    expect(isSearchPath("/chat/search/foo")).toBe(false)
    expect(isSearchPath("/chat/")).toBe(false)
  })

  it("pathForSearch returns the canonical search path", () => {
    expect(pathForSearch()).toBe("/chat/search")
  })
})

describe("pathForSearch(state) / parseSearchUrlState", () => {
  it("omits params entirely for an empty/default state", () => {
    expect(pathForSearch({})).toBe("/chat/search")
    expect(pathForSearch({ sort: "relevance", scope: "all" })).toBe("/chat/search")
  })

  it("includes q when present", () => {
    expect(pathForSearch({ q: "deploy" })).toBe("/chat/search?q=deploy")
  })

  it("omits sort/scope only when at their default", () => {
    expect(pathForSearch({ q: "hi", sort: "recent" })).toBe("/chat/search?q=hi&sort=recent")
    expect(pathForSearch({ q: "hi", scope: "dm" })).toBe("/chat/search?q=hi&scope=dm")
    expect(pathForSearch({ q: "hi", sort: "recent", scope: "group" })).toBe(
      "/chat/search?q=hi&sort=recent&scope=group",
    )
  })

  it("round-trips through parseSearchUrlState", () => {
    const path = pathForSearch({ q: "hello world", sort: "recent", scope: "group" })
    const [, search] = path.split("?")
    expect(parseSearchUrlState(`?${search}`)).toEqual({
      q: "hello world",
      sort: "recent",
      scope: "group",
    })
  })

  it("parseSearchUrlState defaults sort/scope to undefined when absent or garbage", () => {
    expect(parseSearchUrlState("")).toEqual({ q: undefined, sort: undefined, scope: undefined })
    expect(parseSearchUrlState("?sort=bogus&scope=nonsense")).toEqual({
      q: undefined,
      sort: undefined,
      scope: undefined,
    })
  })

  it("Vietnamese/CJK query text survives the round trip", () => {
    const path = pathForSearch({ q: "triển khai 会議" })
    expect(parseSearchUrlState(path.split("?")[1] ? `?${path.split("?")[1]}` : "").q).toBe(
      "triển khai 会議",
    )
  })
})
