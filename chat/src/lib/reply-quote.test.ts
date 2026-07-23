import { describe, expect, it } from "vitest"
import { buildReplyBlockquote, buildReplyBody, quotePreviewHtml } from "./reply-quote"

describe("quotePreviewHtml", () => {
  it("keeps inline emoji and reduces the rest to text", () => {
    const body = '<p>hi <img class="emoji" alt="😀" src="x"> there</p>'
    const out = quotePreviewHtml(body)
    expect(out).toContain('<img class="emoji" alt="😀" src="x">')
    expect(out).toContain("hi")
    expect(out).toContain("there")
    expect(out).not.toContain("<p>")
  })

  it("caps at the visible-char limit with an ellipsis and escapes text", () => {
    const out = quotePreviewHtml(`<div>${"x".repeat(200)} & <b>y</b></div>`, 10)
    expect(out).toBe("xxxxxxxxxx…")
  })

  it("drops a nested reply blockquote (no quote-of-a-quote recursion)", () => {
    const body =
      '<blockquote itemtype="http://schema.skype.com/Reply"><p itemprop="preview">old</p></blockquote>my reply'
    expect(quotePreviewHtml(body)).toBe("my reply")
  })

  it("escapes plain text so it can't inject markup", () => {
    expect(quotePreviewHtml("<div>a & <script>b</script></div>")).toContain("a &amp; b")
  })
})

describe("buildReplyBlockquote", () => {
  const q = {
    msgId: "1784701664692",
    authorMri: "8:orgid:abc-123",
    authorName: "Dustin Do",
    previewHtml: "not too natural",
  }

  it("emits the live-verified Reply blockquote shape with the rich preview", () => {
    expect(buildReplyBlockquote(q)).toBe(
      '<blockquote itemscope itemtype="http://schema.skype.com/Reply" itemid="1784701664692">' +
        '<strong itemprop="mri" itemid="8:orgid:abc-123">Dustin Do</strong>' +
        '<span itemprop="time" itemid="1784701664692"></span>' +
        '<p itemprop="preview">not too natural</p>' +
        "</blockquote>",
    )
  })

  it("HTML-escapes the author name (wire carries the full name)", () => {
    expect(buildReplyBlockquote({ ...q, authorName: "A & B" })).toContain(">A &amp; B</strong>")
  })
})

describe("buildReplyBody (multi-reply)", () => {
  it("stacks quotes in order ahead of the body", () => {
    const q = (id: string) => ({
      msgId: id,
      authorMri: `8:orgid:${id}`,
      authorName: id,
      previewHtml: id,
    })
    const out = buildReplyBody([q("a"), q("b")], "<p>reply</p>")
    expect(out.indexOf('itemid="a"')).toBeLessThan(out.indexOf('itemid="b"'))
    expect(out.indexOf('itemid="b"')).toBeLessThan(out.indexOf("<p>reply</p>"))
  })
})
