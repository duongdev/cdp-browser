import { describe, expect, it } from "vitest"
import { cleanEditorHtml, enterKeyAction, outgoingFromEditor } from "./rich-compose"

describe("enterKeyAction", () => {
  it("sends on plain Enter outside a list", () => {
    expect(enterKeyAction({ shift: false, meta: false, inListItem: false })).toBe("send")
  })
  it("defers to the browser inside a list item (so Enter adds a new item)", () => {
    expect(enterKeyAction({ shift: false, meta: false, inListItem: true })).toBe("default")
  })
  it("defers on Shift+Enter (soft line break)", () => {
    expect(enterKeyAction({ shift: true, meta: false, inListItem: false })).toBe("default")
  })
  it("always sends on Cmd/Ctrl+Enter, even in a list", () => {
    expect(enterKeyAction({ shift: false, meta: true, inListItem: true })).toBe("send")
  })
})

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
    expect(outgoingFromEditor("<div><br></div> ")).toEqual({
      text: "",
      html: null,
      displayHtml: null,
      mentions: [],
    })
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

describe("outgoingFromEditor — @mentions (PSN-92 D)", () => {
  const pill = (mri: string, name: string, display = name) =>
    `<span class="mention" data-mri="${mri}" data-name="${name}" contenteditable="false">@${display}</span>`

  it("splits a mention into per-token wire spans + a mentions array", () => {
    const out = outgoingFromEditor(`${pill("8:orgid:abc", "Dustin Do")} hi`)
    // two tokens → two spans, same mri, sequential itemids
    expect(out.mentions).toEqual([
      { itemid: 0, mri: "8:orgid:abc", displayName: "Dustin" },
      { itemid: 1, mri: "8:orgid:abc", displayName: "Do" },
    ])
    expect(out.html).toContain(
      '<span itemtype="http://schema.skype.com/Mention" itemscope="" itemid="0">Dustin</span>',
    )
    expect(out.html).toContain('itemid="1">Do</span>')
    expect(out.html).toContain("&nbsp;")
    // display path keeps a single pill for the optimistic bubble
    expect(out.displayHtml).toContain('<span class="mention">@Dustin Do</span>')
    // text carries the @name
    expect(out.text).toContain("@Dustin Do")
  })

  it("assigns global itemids across two mentions", () => {
    const out = outgoingFromEditor(`${pill("8:orgid:a", "Al")} and ${pill("8:orgid:b", "Bo")}`)
    expect(out.mentions.map((m) => m.itemid)).toEqual([0, 1])
    expect(out.mentions.map((m) => m.mri)).toEqual(["8:orgid:a", "8:orgid:b"])
  })

  it("a plain message has no mentions and a null html", () => {
    const out = outgoingFromEditor("<div>hello</div>")
    expect(out.mentions).toEqual([])
    expect(out.html).toBeNull()
  })
})
