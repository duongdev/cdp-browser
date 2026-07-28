import { describe, expect, it } from "vitest"
import { isSearchPath, parsePath, pathFor, pathForSearch } from "./chat-route"

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
