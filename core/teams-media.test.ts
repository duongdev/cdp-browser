import { describe, expect, it } from "vitest"
// AMS media SSRF gate + HTML rewrite (t117, ADR-0018). AMS media 401s from a server-side / no-cors
// fetch; it loads only via an IN-PAGE fetch with the skypetoken. The proxy is CA-proof like the rest
// of Teams, so a garbled/hostile `src` must not steer the in-page fetch at an arbitrary host.
import { amsObjectId, isValidAmsUrl, rewriteMediaHtml } from "./teams-media"

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
})
