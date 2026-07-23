import { describe, expect, it } from "vitest"
// CommonJS module shared with web/server.mjs (which builds the sent-image content server-side).
import { buildAmsImageContent } from "./teams-ams"

describe("buildAmsImageContent", () => {
  const base = { host: "https://as-prod.asyncgw.teams.microsoft.com", objId: "0-ea-d1-abc" }

  it("embeds the AMSImage img pointing at the object's imgo display view", () => {
    const out = buildAmsImageContent({ ...base, width: 640, height: 480 })
    expect(out).toContain(
      'src="https://as-prod.asyncgw.teams.microsoft.com/v1/objects/0-ea-d1-abc/views/imgo"',
    )
    expect(out).toContain('itemtype="http://schema.skype.com/AMSImage"')
    expect(out).toContain('width="640"')
    expect(out).toContain('height="480"')
  })

  it("omits dimensions when width/height are missing or non-positive", () => {
    const out = buildAmsImageContent({ ...base, width: 0, height: 0 })
    expect(out).not.toContain("width=")
    expect(out).not.toContain("height=")
    expect(out).toContain("/views/imgo")
  })

  it("normalizes a trailing slash on the host", () => {
    const out = buildAmsImageContent({ host: `${base.host}/`, objId: base.objId })
    expect(out).toContain(`${base.host}/v1/objects/${base.objId}/views/imgo`)
    expect(out).not.toContain("com//v1")
  })

  it("has no caption prefix when caption is empty/whitespace", () => {
    expect(buildAmsImageContent({ ...base })).toMatch(/^<img /)
    expect(buildAmsImageContent({ ...base, caption: "   " })).toMatch(/^<img /)
  })

  it("HTML-escapes the caption and prepends it before the img", () => {
    const out = buildAmsImageContent({ ...base, caption: 'a <b> & "c"' })
    expect(out).toContain("a &lt;b&gt; &amp; &quot;c&quot;<br>")
    expect(out.indexOf("&lt;b&gt;")).toBeLessThan(out.indexOf("<img "))
  })

  it("converts caption newlines to <br>", () => {
    const out = buildAmsImageContent({ ...base, caption: "line1\nline2" })
    expect(out).toContain("line1<br>line2<br>")
  })
})
