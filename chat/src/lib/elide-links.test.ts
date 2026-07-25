// @vitest-environment jsdom
// elideLinkText uses DOMParser to walk anchors, so this file needs the jsdom environment.
import { describe, expect, it } from "vitest"
import { elideLinkText, isUrlLike, middleEllipsis } from "./elide-links"

describe("middleEllipsis", () => {
  it("keeps short strings intact", () => {
    expect(middleEllipsis("https://x.com/a")).toBe("https://x.com/a")
  })
  it("elides the middle of a long url, keeping head + tail", () => {
    const url =
      "https://dev.azure.com/FWDGODevOps/Digital_GenAI/_git/genai-guru-trainer-config-service/pullrequest/156680"
    const out = middleEllipsis(url)
    expect(out).toContain("…")
    expect(out.startsWith("https://dev.azure.com/FWDGODev")).toBe(true)
    expect(out.endsWith("156680")).toBe(true)
    expect(out.length).toBeLessThan(url.length)
  })
})

describe("isUrlLike", () => {
  it("matches bare urls", () => {
    expect(isUrlLike("https://a.com/b")).toBe(true)
    expect(isUrlLike("www.a.com/b")).toBe(true)
  })
  it("rejects descriptive text", () => {
    expect(isUrlLike("click here")).toBe(false)
    expect(isUrlLike("see https://a.com now")).toBe(false)
  })
})

describe("elideLinkText", () => {
  const long =
    "https://dev.azure.com/FWDGODevOps/Digital_GenAI/_git/genai-guru-trainer-config-service/pullrequest/156680"
  it("elides an anchor whose text is a long url, keeps href", () => {
    const out = elideLinkText(`<a href="${long}">${long}</a>`)
    expect(out).toContain("…")
    expect(out).toContain(`href="${long}"`)
    expect(out).toContain(`title="${long}"`)
  })
  it("leaves a labelled link untouched", () => {
    const html = `<a href="${long}">the PR</a>`
    expect(elideLinkText(html)).toBe(html)
  })
  it("no-ops html without anchors", () => {
    expect(elideLinkText("<p>hello</p>")).toBe("<p>hello</p>")
  })
})
