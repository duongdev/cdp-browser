import { describe, expect, it } from "vitest"
import { htmlToPlain } from "./html-to-plain"

describe("htmlToPlain", () => {
  it("returns empty for empty/undefined-like input", () => {
    expect(htmlToPlain("")).toBe("")
  })

  it("strips a plain paragraph to its text", () => {
    expect(htmlToPlain("<p>hello world</p>")).toBe("hello world")
  })

  it("keeps inline formatting text but drops the tags", () => {
    expect(htmlToPlain("<p>a <b>bold</b> and <i>italic</i> word</p>")).toBe(
      "a bold and italic word",
    )
  })

  it("turns <br> into a newline", () => {
    expect(htmlToPlain("line1<br>line2")).toBe("line1\nline2")
    expect(htmlToPlain("line1<br/>line2")).toBe("line1\nline2")
  })

  it("newlines between paragraphs / list items", () => {
    expect(htmlToPlain("<p>one</p><p>two</p>")).toBe("one\ntwo")
    expect(htmlToPlain("<ul><li>a</li><li>b</li></ul>")).toBe("a\nb")
  })

  it("decodes the common entities, &amp; last", () => {
    expect(htmlToPlain("Tom &amp; Jerry")).toBe("Tom & Jerry")
    expect(htmlToPlain("a &lt; b &gt; c")).toBe("a < b > c")
    expect(htmlToPlain("say &quot;hi&quot; it&#39;s me")).toBe('say "hi" it\'s me')
    expect(htmlToPlain("&amp;lt;")).toBe("&lt;") // no double-decode
    expect(htmlToPlain("&nbsp;x")).toBe("x")
  })

  it("collapses runaway blank lines and trims", () => {
    expect(htmlToPlain("<p>a</p><br><br><br><p>b</p>")).toBe("a\n\nb")
  })

  it("drops a mention span but keeps its text", () => {
    expect(htmlToPlain('<p>hi <span itemtype="…/Mention">@Dustin</span>!</p>')).toBe("hi @Dustin!")
  })
})
