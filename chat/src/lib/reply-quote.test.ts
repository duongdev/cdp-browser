import { describe, expect, it } from "vitest"
import { buildReplyBlockquote, truncatePreview } from "./reply-quote"

describe("truncatePreview", () => {
  it("collapses whitespace and trims", () => {
    expect(truncatePreview("  a\n  b  ")).toBe("a b")
  })
  it("caps at 120 chars with an ellipsis", () => {
    const out = truncatePreview("x".repeat(200))
    expect(out.length).toBe(120)
    expect(out.endsWith("…")).toBe(true)
  })
  it("keeps short text intact", () => {
    expect(truncatePreview("hello")).toBe("hello")
  })
})

describe("buildReplyBlockquote", () => {
  const q = {
    msgId: "1784701664692",
    authorMri: "8:orgid:abc-123",
    authorName: "Dustin Do",
    previewText: "not too natural",
  }

  it("emits the live-verified Reply blockquote shape", () => {
    expect(buildReplyBlockquote(q)).toBe(
      '<blockquote itemscope itemtype="http://schema.skype.com/Reply" itemid="1784701664692">' +
        '<strong itemprop="mri" itemid="8:orgid:abc-123">Dustin Do</strong>' +
        '<span itemprop="time" itemid="1784701664692"></span>' +
        '<p itemprop="preview">not too natural</p>' +
        "</blockquote>",
    )
  })

  it("HTML-escapes the author name and preview", () => {
    const out = buildReplyBlockquote({
      ...q,
      authorName: "A & B",
      previewText: "<script>x</script>",
    })
    expect(out).toContain(">A &amp; B</strong>")
    expect(out).toContain("&lt;script&gt;x&lt;/script&gt;")
    expect(out).not.toContain("<script>")
  })
})
