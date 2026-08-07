// @vitest-environment jsdom
// markMessageLinks uses DOMParser to walk anchors, so this file needs the jsdom environment.
import { describe, expect, it } from "vitest"
import { elideLinkText } from "./link-label"
import { IN_APP_LINK_CLASS, markMessageLinks } from "./message-link-affordance"

const ORIGIN = "https://portal.example.com"
const TEAMS_LINK = "https://teams.microsoft.com/l/message/19:x@thread.v2/1786073725445"

describe("markMessageLinks", () => {
  it("tags an anchor that points at a resolvable message", () => {
    const out = markMessageLinks(`<p>see <a href="${TEAMS_LINK}">this</a></p>`, ORIGIN)
    expect(out).toContain(IN_APP_LINK_CLASS)
    expect(out).toContain('title="Open this message in Chats"')
  })

  it("leaves an ordinary external link alone", () => {
    const html = '<p>docs at <a href="https://example.com/docs">here</a></p>'
    expect(markMessageLinks(html, ORIGIN)).toBe(html)
  })

  it("leaves a message link from a FOREIGN origin alone (it is not ours to resolve)", () => {
    const html = '<a href="https://evil.example.com/chat/c/19:x@thread.v2?msg=17">x</a>'
    expect(markMessageLinks(html, ORIGIN)).toBe(html)
  })

  it("tags this app's own deep link", () => {
    const out = markMessageLinks(`<a href="${ORIGIN}/chat/c/19:x@thread.v2?msg=17">x</a>`, ORIGIN)
    expect(out).toContain(IN_APP_LINK_CLASS)
  })

  it("returns the input untouched when there are no anchors at all", () => {
    const html = "<p>plain text, no links</p>"
    expect(markMessageLinks(html, ORIGIN)).toBe(html)
  })

  it("tags only the resolvable anchors in a mixed body", () => {
    const out = markMessageLinks(
      `<a href="https://example.com">a</a><a href="${TEAMS_LINK}">b</a>`,
      ORIGIN,
    )
    expect(out.match(new RegExp(IN_APP_LINK_CLASS, "g"))).toHaveLength(1)
  })

  it("keeps an existing title rather than overwriting the author's", () => {
    const out = markMessageLinks(`<a href="${TEAMS_LINK}" title="mine">x</a>`, ORIGIN)
    expect(out).toContain('title="mine"')
    expect(out).not.toContain("Open this message in Chats")
  })

  it("preserves the href and the link text exactly", () => {
    const out = markMessageLinks(`<a href="${TEAMS_LINK}">the message</a>`, ORIGIN)
    expect(out).toContain(`href="${TEAMS_LINK}"`)
    expect(out).toContain(">the message<")
  })

  it("keeps classes the sanitizer already put on the anchor", () => {
    const out = markMessageLinks(`<a class="emoji" href="${TEAMS_LINK}">x</a>`, ORIGIN)
    expect(out).toContain("emoji")
    expect(out).toContain(IN_APP_LINK_CLASS)
  })

  // A malformed href must not take the whole body render down with it.
  it("survives a malformed href without throwing", () => {
    const html = '<a href="https://teams.microsoft.com/l/message/%E0%A4%A/17">x</a>'
    expect(() => markMessageLinks(html, ORIGIN)).not.toThrow()
    expect(markMessageLinks(html, ORIGIN)).toBe(html)
  })

  // Pipeline order guard: elideLinkText (PSN-99) stamps the raw href as the title of every anchor
  // that lacks one, so it must run AFTER this. Running it first silently wins the title and the
  // jump hint never reaches the user — which is exactly what happened before this test existed.
  it("sets the jump hint before elideLinkText can claim the title", () => {
    const marked = markMessageLinks(`<a href="${TEAMS_LINK}">the message</a>`, ORIGIN)
    const elided = elideLinkText(marked)
    expect(elided).toContain('title="Open this message in Chats"')
    expect(elided).toContain(IN_APP_LINK_CLASS)
  })

  it("still lets elideLinkText title an ordinary link with its href", () => {
    const elided = elideLinkText(markMessageLinks('<a href="https://example.com/x">x</a>', ORIGIN))
    expect(elided).toContain('title="https://example.com/x"')
    expect(elided).not.toContain(IN_APP_LINK_CLASS)
  })
})
