import { describe, expect, it } from "vitest"
// AMS media SSRF gate + HTML rewrite (t139, ADR-0019). AMS media 401s from a server-side / no-cors
// fetch; it loads only via an IN-PAGE fetch with the skypetoken. The proxy is CA-proof like the rest
// of Teams, so a garbled/hostile `src` must not steer the in-page fetch at an arbitrary host.
import { amsObjectId, ensureMediaDimensions, isValidAmsUrl, rewriteMediaHtml } from "./teams-media"

const ASM = "https://as-api.asm.skype.com/v1/objects/0-eus-d1-abc123/views/imgo"
const ASYNC_IMG =
  "https://as-prod.asyncgw.teams.microsoft.com/v1/objects/0-eus-d2-def456/views/imgo"
const ASYNC_VID =
  "https://as-prod.asyncgw.teams.microsoft.com/v1/objects/0-eus-d3-ghi789/views/video"
const GIPHY = "https://media1.giphy.com/media/xyz/giphy.gif"
const STATICS =
  "https://statics.teams.cdn.office.net/evergreen-assets/personal-expressions/giggle.png"

const proxy = (u: string) => `/api/teams/media?url=${encodeURIComponent(u)}`

describe("isValidAmsUrl", () => {
  it("accepts an as-api.asm.skype.com object url", () => {
    expect(isValidAmsUrl(ASM)).toBe(true)
  })
  it("accepts an asyncgw image object url", () => {
    expect(isValidAmsUrl(ASYNC_IMG)).toBe(true)
  })
  it("accepts an asyncgw video object url", () => {
    expect(isValidAmsUrl(ASYNC_VID)).toBe(true)
  })
  it("accepts any *.asm.skype.com subdomain", () => {
    expect(isValidAmsUrl("https://uk-api.asm.skype.com/v1/objects/x/views/imgo")).toBe(true)
  })
  it("rejects a non-https scheme", () => {
    expect(isValidAmsUrl("http://as-api.asm.skype.com/v1/objects/x/views/imgo")).toBe(false)
  })
  it("rejects a public CDN host (giphy)", () => {
    expect(isValidAmsUrl(GIPHY)).toBe(false)
  })
  it("rejects the teams static CDN host", () => {
    expect(isValidAmsUrl(STATICS)).toBe(false)
  })
  it("rejects an AMS host with a non-object path", () => {
    expect(isValidAmsUrl("https://as-api.asm.skype.com/v1/users/ME/messages")).toBe(false)
  })
  it("rejects a look-alike host suffix (SSRF)", () => {
    expect(isValidAmsUrl("https://as-api.asm.skype.com.evil.com/v1/objects/x/views/imgo")).toBe(
      false,
    )
    expect(isValidAmsUrl("https://xasm.skype.com/v1/objects/x/views/imgo")).toBe(false)
  })
  it("rejects an arbitrary host even with an /v1/objects/ path", () => {
    expect(isValidAmsUrl("https://evil.com/v1/objects/x/views/imgo")).toBe(false)
  })
  it("rejects garbage / non-string input", () => {
    expect(isValidAmsUrl("not a url")).toBe(false)
    // @ts-expect-error null is a runtime guard, not a typed input
    expect(isValidAmsUrl(null)).toBe(false)
    expect(isValidAmsUrl("")).toBe(false)
  })
})

describe("amsObjectId", () => {
  it("extracts the object id from the path", () => {
    expect(amsObjectId(ASM)).toBe("0-eus-d1-abc123")
  })
  it("returns null for a non-object / garbage url", () => {
    expect(amsObjectId(GIPHY)).toBe(null)
    expect(amsObjectId("nope")).toBe(null)
  })
})

describe("rewriteMediaHtml", () => {
  it("rewrites an AMS <img> src to the proxy url and keeps other attrs", () => {
    const html = `<img itemtype="http://schema.skype.com/AMSImage" src="${ASM}" width="200" height="150">`
    const out = rewriteMediaHtml(html)
    expect(out).toContain(`src="${proxy(ASM)}"`)
    expect(out).toContain('itemtype="http://schema.skype.com/AMSImage"')
    expect(out).toContain('width="200"')
    // the bare src is gone — the host only survives inside the encoded ?url= param
    expect(out).not.toContain(`src="${ASM}"`)
  })
  it("rewrites an AMS <video> src to the proxy url", () => {
    const html = `<video src="${ASYNC_VID}" itemtype="http://schema.skype.com/AMSVideo" data-duration="PT27S">`
    const out = rewriteMediaHtml(html)
    expect(out).toContain(`src="${proxy(ASYNC_VID)}"`)
    expect(out).toContain('data-duration="PT27S"')
  })
  it("leaves a giphy GIF src untouched", () => {
    const html = `<img src="${GIPHY}" width="220" alt="gif">`
    expect(rewriteMediaHtml(html)).toBe(html)
  })
  it("leaves a teams-static emoji/sticker src untouched", () => {
    const html = `<img itemtype="http://schema.skype.com/Emoji" src="${STATICS}">`
    expect(rewriteMediaHtml(html)).toBe(html)
  })
  it("leaves a malformed / non-AMS src untouched", () => {
    const html = `<img src="javascript:alert(1)"><img src="/local/path.png">`
    expect(rewriteMediaHtml(html)).toBe(html)
  })
  it("handles multiple media tags in one body", () => {
    const html = `<img src="${ASM}"> and <img src="${GIPHY}">`
    const out = rewriteMediaHtml(html)
    expect(out).toContain(`src="${proxy(ASM)}"`)
    expect(out).toContain(`src="${GIPHY}"`)
  })
  it("decodes &amp; entities in the AMS src before encoding", () => {
    const raw = "https://as-api.asm.skype.com/v1/objects/x/views/imgo?a=1&amp;b=2"
    const decoded = "https://as-api.asm.skype.com/v1/objects/x/views/imgo?a=1&b=2"
    const out = rewriteMediaHtml(`<img src="${raw}">`)
    expect(out).toContain(`src="${proxy(decoded)}"`)
  })
  it("returns non-string input unchanged", () => {
    // @ts-expect-error runtime guard
    expect(rewriteMediaHtml(null)).toBe(null)
    expect(rewriteMediaHtml("")).toBe("")
  })
  it("also reserves dimensions from a style-only AMS img (composes with the src rewrite)", () => {
    const out = rewriteMediaHtml(`<img src="${ASM}" style="width:1080px; height:1363px">`)
    expect(out).toContain(`src="${proxy(ASM)}"`)
    expect(out).toContain('width="1080"')
    expect(out).toContain('height="1363"')
  })
})

// FIX B (t140): AMS imgs sometimes carry no width/height ATTRS, only an inline `style` (which
// DOMPurify strips) — so the box has zero reserved height until bytes load, then jumps → scroll
// flicker. Convert `style="width:Npx; height:Npx"` to real width/height attrs so the browser derives
// the aspect-ratio box before load. Tags that already have the attrs, or neither, are left alone.
describe("ensureMediaDimensions", () => {
  it("adds width/height attrs from a style-only img", () => {
    const out = ensureMediaDimensions('<img src="x.png" style="width:1080px; height:1363px">')
    expect(out).toBe(
      '<img width="1080" height="1363" src="x.png" style="width:1080px; height:1363px">',
    )
  })
  it("adds attrs to a style-only video", () => {
    const out = ensureMediaDimensions('<video src="v.mp4" style="width:640px;height:360px">')
    expect(out).toContain('width="640"')
    expect(out).toContain('height="360"')
  })
  it("leaves a tag that already has width/height attrs untouched (no doubling)", () => {
    const html = '<img src="x.png" width="200" height="150" style="width:1080px; height:1363px">'
    expect(ensureMediaDimensions(html)).toBe(html)
  })
  it("leaves a tag with only a width attr untouched", () => {
    const html = '<img src="x.png" width="200">'
    expect(ensureMediaDimensions(html)).toBe(html)
  })
  it("leaves a tag with neither attrs nor style-dims untouched", () => {
    const html = '<img src="x.png">'
    expect(ensureMediaDimensions(html)).toBe(html)
  })
  it("ignores a style with no px dimensions", () => {
    const html = '<img src="x.png" style="max-width:100%">'
    expect(ensureMediaDimensions(html)).toBe(html)
  })
  it("does not confuse max-width/min-height for the real dimensions", () => {
    const out = ensureMediaDimensions(
      '<img src="x.png" style="max-width:100%; width:800px; min-height:10px; height:600px">',
    )
    expect(out).toContain('width="800"')
    expect(out).toContain('height="600"')
  })
  it("handles decimal px values", () => {
    const out = ensureMediaDimensions('<img src="x.png" style="width:100.5px;height:50.25px">')
    expect(out).toContain('width="100.5"')
    expect(out).toContain('height="50.25"')
  })
  it("leaves a non-media tag untouched", () => {
    const html = '<span style="width:10px;height:10px">hi</span>'
    expect(ensureMediaDimensions(html)).toBe(html)
  })
  it("returns non-string input unchanged", () => {
    // @ts-expect-error runtime guard
    expect(ensureMediaDimensions(null)).toBe(null)
    expect(ensureMediaDimensions("")).toBe("")
  })
})
