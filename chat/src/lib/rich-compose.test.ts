import { describe, expect, it } from "vitest"
import { cleanEditorHtml, outgoingFromEditor } from "./rich-compose"

describe("cleanEditorHtml — outgoing allowlist", () => {
  it("keeps formatting tags and drops their attributes", () => {
    expect(cleanEditorHtml('<b style="color:red">hi</b> <i class="x">there</i>')).toBe(
      "<b>hi</b> <i>there</i>",
    )
  })

  it("drops disallowed tags but keeps their text", () => {
    expect(cleanEditorHtml("<script>alert(1)</script><h1>title</h1>")).toBe("alert(1)title")
  })

  it("keeps only safe hrefs on links", () => {
    expect(cleanEditorHtml('<a href="https://x.io" onclick="p()">x</a>')).toBe(
      '<a href="https://x.io">x</a>',
    )
    expect(cleanEditorHtml('<a href="javascript:p()">x</a>')).toBe("<a>x</a>")
  })

  it("strips comments", () => {
    expect(cleanEditorHtml("a<!-- hidden -->b")).toBe("ab")
  })
})

describe("outgoingFromEditor — text vs rich send", () => {
  it("whitespace-only content sends nothing", () => {
    expect(outgoingFromEditor("<div><br></div> ")).toEqual({ text: "", html: null })
  })

  it("plain multi-line stays a text send (divs/brs are structure, not formatting)", () => {
    const out = outgoingFromEditor("<div>line one</div><div>line two</div>")
    expect(out.text).toBe("line one\nline two")
    expect(out.html).toBeNull()
  })

  it("real formatting yields an html payload alongside the text", () => {
    const out = outgoingFromEditor("<div><b>bold</b> and plain</div>")
    expect(out.text).toBe("bold and plain")
    expect(out.html).toBe("<div><b>bold</b> and plain</div>")
  })

  it("a list is formatting", () => {
    const out = outgoingFromEditor("<ul><li>a</li><li>b</li></ul>")
    expect(out.html).toContain("<ul>")
    expect(out.text).toBe("a\nb")
  })
})
