import { describe, expect, it } from "vitest"
// @ts-expect-error — plain CJS module, no types
import { isExternalUrl, resolveServerUrl } from "./chat-shell.js"

describe("resolveServerUrl", () => {
  it("prefers env over stored over fallback", () => {
    expect(resolveServerUrl("http://a", "http://b", "http://c")).toBe("http://a")
    expect(resolveServerUrl("", "http://b", "http://c")).toBe("http://b")
    expect(resolveServerUrl(null, null, "http://c")).toBe("http://c")
  })

  it("trims trailing slashes", () => {
    expect(resolveServerUrl("http://host:7800/", null, "")).toBe("http://host:7800")
    expect(resolveServerUrl("http://host:7800///", null, "")).toBe("http://host:7800")
  })
})

describe("isExternalUrl", () => {
  const server = "http://host:7800"
  it("keeps same-origin navigations in the shell", () => {
    expect(isExternalUrl("http://host:7800/chat/", server)).toBe(false)
    expect(isExternalUrl("http://host:7800/chat/c/19:abc", server)).toBe(false)
  })
  it("sends other origins to the browser", () => {
    expect(isExternalUrl("https://teams.microsoft.com/x", server)).toBe(true)
    expect(isExternalUrl("http://host:7801/chat/", server)).toBe(true)
  })
  it("treats a malformed url as external", () => {
    expect(isExternalUrl("not a url", server)).toBe(true)
  })
})
