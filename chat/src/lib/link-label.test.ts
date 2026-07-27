// @vitest-environment jsdom
// elideLinkText uses DOMParser to walk anchors, so this file needs the jsdom environment.
import { describe, expect, it } from "vitest"
import {
  elideLinkText,
  isUrlLike,
  labelMarkdownLinks,
  linkLabel,
  middleEllipsis,
  parseAzurePr,
} from "./link-label"

const PR_URL =
  "https://dev.azure.com/FWDGODevOps/Digital_GenAI/_git/genai-guru-trainer-config-service/pullrequest/156680"
const PR_CHIP = "genai-guru-trainer-config-service#156680"
const LONG_URL = `https://example.com/some/very/long/path/that/keeps/going/and/going/${"x".repeat(40)}`

describe("middleEllipsis", () => {
  it("keeps short strings intact", () => {
    expect(middleEllipsis("https://x.com/a")).toBe("https://x.com/a")
  })
  it("elides the middle of a long url, keeping head + tail", () => {
    const out = middleEllipsis(PR_URL)
    expect(out).toContain("…")
    expect(out.startsWith("https://dev.azure.com/FWDGODev")).toBe(true)
    expect(out.endsWith("156680")).toBe(true)
    expect(out.length).toBeLessThan(PR_URL.length)
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

describe("parseAzurePr", () => {
  it("reads repo + id from a dev.azure.com PR url", () => {
    expect(parseAzurePr(PR_URL)).toEqual({
      repo: "genai-guru-trainer-config-service",
      id: "156680",
    })
  })
  it("reads the legacy visualstudio.com host", () => {
    expect(parseAzurePr("https://fwd.visualstudio.com/P/_git/repo-a/pullrequest/42")).toEqual({
      repo: "repo-a",
      id: "42",
    })
  })
  it("ignores non-PR azure urls and other hosts", () => {
    expect(parseAzurePr("https://dev.azure.com/org/proj/_git/repo")).toBeNull()
    expect(parseAzurePr("https://github.com/o/r/pull/1")).toBeNull()
  })
})

describe("linkLabel", () => {
  it("chips an azure PR", () => {
    expect(linkLabel(PR_URL)).toBe(PR_CHIP)
  })
  it("elides any other long url", () => {
    expect(linkLabel(LONG_URL)).toContain("…")
  })
  it("leaves a short url alone", () => {
    expect(linkLabel("https://x.com/a")).toBeNull()
  })
})

describe("elideLinkText", () => {
  it("chips an anchor showing an azure PR url, keeps href", () => {
    const out = elideLinkText(`<a href="${PR_URL}">${PR_URL}</a>`)
    expect(out).toContain(`>${PR_CHIP}<`)
    expect(out).toContain(`href="${PR_URL}"`)
    expect(out).toContain(`title="${PR_URL}"`)
  })
  it("labels from the HREF, not a Teams-pre-shortened display text (no double ellipsis)", () => {
    const shown = "https://example.com/some/very…xxxx"
    const out = elideLinkText(`<a href="${LONG_URL}">${shown}</a>`)
    const text = out.slice(out.indexOf(">") + 1, out.lastIndexOf("<"))
    expect((text.match(/…/g) ?? []).length).toBe(1)
    expect(text.startsWith("https://example.com/some/very")).toBe(true)
  })
  it("leaves a labelled link untouched", () => {
    const html = `<a href="${PR_URL}">the PR</a>`
    expect(elideLinkText(html)).toBe(html)
  })
  it("no-ops html without anchors", () => {
    expect(elideLinkText("<p>hello</p>")).toBe("<p>hello</p>")
  })
})

describe("labelMarkdownLinks", () => {
  it("chips a bare azure PR url", () => {
    expect(labelMarkdownLinks(`see ${PR_URL} please`)).toBe(`see [${PR_CHIP}](${PR_URL}) please`)
  })
  it("keeps trailing sentence punctuation outside the link", () => {
    expect(labelMarkdownLinks(`${PR_URL}.`)).toBe(`[${PR_CHIP}](${PR_URL}).`)
  })
  it("relabels a link whose text is the same url", () => {
    expect(labelMarkdownLinks(`[${PR_URL}](${PR_URL})`)).toBe(`[${PR_CHIP}](${PR_URL})`)
  })
  it("never double-wraps an already-labelled link", () => {
    const md = `[the PR](${PR_URL})`
    expect(labelMarkdownLinks(md)).toBe(md)
  })
  it("leaves short urls and plain prose alone", () => {
    expect(labelMarkdownLinks("nothing here, see https://x.com/a")).toBe(
      "nothing here, see https://x.com/a",
    )
  })
})
