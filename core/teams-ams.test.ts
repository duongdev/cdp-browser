import { describe, expect, it } from "vitest"
// CommonJS module shared with web/server.mjs (which builds the sent-image content server-side).
import { buildAmsImageContent, buildAmsImageContentMulti } from "./teams-ams"

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

describe("buildAmsImageContentMulti", () => {
  const host = "https://as-prod.asyncgw.teams.microsoft.com"
  const img1 = { host, objId: "obj-1", width: 640, height: 480 }
  const img2 = { host, objId: "obj-2", width: 320, height: 240 }

  it("returns empty string for empty/missing array", () => {
    expect(buildAmsImageContentMulti([], "cap")).toBe("")
    expect(buildAmsImageContentMulti(null, "cap")).toBe("")
  })

  it("single image matches single buildAmsImageContent (no caption)", () => {
    const multi = buildAmsImageContentMulti([img1])
    const single = buildAmsImageContent(img1)
    expect(multi).toBe(single)
  })

  it("emits one AMSImage img per image separated by <br>", () => {
    const out = buildAmsImageContentMulti([img1, img2])
    expect(out).toContain(
      'src="https://as-prod.asyncgw.teams.microsoft.com/v1/objects/obj-1/views/imgo"',
    )
    expect(out).toContain(
      'src="https://as-prod.asyncgw.teams.microsoft.com/v1/objects/obj-2/views/imgo"',
    )
    // the two <img> tags are separated by a <br>
    expect(out).toMatch(/<img[^>]+obj-1[^>]+><br><img[^>]+obj-2/)
  })

  it("prepends the caption before all images", () => {
    const out = buildAmsImageContentMulti([img1, img2], "look at these")
    expect(out.startsWith("look at these<br>")).toBe(true)
    expect(out.indexOf("look at these")).toBeLessThan(out.indexOf("<img "))
  })

  it("HTML-escapes the caption", () => {
    const out = buildAmsImageContentMulti([img1], '<b> & "c"')
    expect(out).toContain("&lt;b&gt; &amp; &quot;c&quot;<br>")
  })

  it("omits dimensions when missing or zero", () => {
    const out = buildAmsImageContentMulti([{ host, objId: "obj-3", width: 0, height: 0 }])
    expect(out).not.toContain("width=")
    expect(out).not.toContain("height=")
  })
})
