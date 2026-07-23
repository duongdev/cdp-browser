// @vitest-environment jsdom
// DOMPurify needs a real DOM, so this file runs in the jsdom Vitest environment (the rest of the
// suite stays in the default Node env). These are the XSS boundary tests: message HTML is
// site-authored, and sanitize() is the ONLY thing between it and dangerouslySetInnerHTML.
import { describe, expect, it } from "vitest"
import { sanitize } from "./sanitize-message"

describe("sanitize — strips dangerous content", () => {
  it("removes <script> entirely", () => {
    expect(sanitize("hi<script>alert(1)</script>bye")).toBe("hibye")
  })

  it("keeps data-fullname on a mention pill (PSN-92 E tooltip anchor)", () => {
    const out = sanitize(
      '<span class="mention" data-fullname="Glory Nguyen - Group Office">@Glory</span>',
    )
    expect(out).toContain('data-fullname="Glory Nguyen - Group Office"')
    expect(out).toContain('class="mention"')
  })

  it("removes <style>", () => {
    expect(sanitize("a<style>.x{color:red}</style>b")).toBe("ab")
  })

  it("removes <iframe>", () => {
    expect(sanitize('<iframe src="https://evil.test"></iframe>ok')).toBe("ok")
  })

  it("drops on* event-handler attributes", () => {
    const out = sanitize('<img src="x.png" onerror="alert(1)">')
    expect(out).not.toContain("onerror")
    expect(out).toContain("<img")
  })

  it("drops a javascript: href", () => {
    const out = sanitize('<a href="javascript:alert(1)">click</a>')
    expect(out).not.toContain("javascript:")
    expect(out).toContain("click")
  })

  it("does not allow a data: image src to smuggle script", () => {
    const out = sanitize('<img src="data:text/html,<script>alert(1)</script>">')
    expect(out).not.toContain("<script")
  })
})

describe("sanitize — keeps allowed rich content", () => {
  it("keeps formatting tags", () => {
    expect(sanitize("<b>b</b> <i>i</i> <u>u</u> <s>s</s> <em>e</em> <strong>st</strong>")).toBe(
      "<b>b</b> <i>i</i> <u>u</u> <s>s</s> <em>e</em> <strong>st</strong>",
    )
  })

  it("keeps lists, blockquotes, code and pre", () => {
    const html = "<ul><li>a</li></ul><blockquote>q</blockquote><pre><code>x()</code></pre>"
    expect(sanitize(html)).toBe(html)
  })

  it("keeps a mention span with its class", () => {
    expect(sanitize('<span class="mention">@Alice</span>')).toBe(
      '<span class="mention">@Alice</span>',
    )
  })

  it("keeps HTML entities encoded", () => {
    expect(sanitize("a &amp; b &lt;3")).toBe("a &amp; b &lt;3")
  })
})

describe("sanitize — link hardening", () => {
  it("forces target=_blank and rel=noopener noreferrer on an http link", () => {
    const out = sanitize('<a href="https://x.test">x</a>')
    expect(out).toContain('href="https://x.test"')
    expect(out).toContain('target="_blank"')
    expect(out).toContain('rel="noopener noreferrer"')
  })

  it("keeps a mailto href", () => {
    expect(sanitize('<a href="mailto:a@b.test">mail</a>')).toContain('href="mailto:a@b.test"')
  })

  it("drops a non-http(s)/mailto href but keeps the link text", () => {
    const out = sanitize('<a href="ftp://x.test">f</a>')
    expect(out).not.toContain("ftp://")
    expect(out).toContain(">f</a>")
  })
})

describe("sanitize — images", () => {
  it("keeps an emoji img and adds loading=lazy", () => {
    const out = sanitize('<img class="emoji" src="e.png" alt="😄">')
    expect(out).toContain("<img")
    expect(out).toContain('class="emoji"')
    expect(out).toContain('loading="lazy"')
  })
})

describe("sanitize — media (t139)", () => {
  it("keeps itemtype/width/height on an image (for the media-kind CSS)", () => {
    const out = sanitize(
      '<img itemtype="http://schema.skype.com/AMSImage" src="/api/teams/media?url=x" width="200" height="150">',
    )
    expect(out).toContain('itemtype="http://schema.skype.com/AMSImage"')
    expect(out).toContain('width="200"')
    expect(out).toContain('height="150"')
  })

  it("keeps the same-origin media-proxy src", () => {
    const out = sanitize('<img src="/api/teams/media?url=https%3A%2F%2Fas-api.asm.skype.com%2Fa">')
    expect(out).toContain('src="/api/teams/media?url=https%3A%2F%2Fas-api.asm.skype.com%2Fa"')
  })

  it("keeps a public-CDN giphy src", () => {
    const out = sanitize('<img src="https://media1.giphy.com/media/x/giphy.gif">')
    expect(out).toContain('src="https://media1.giphy.com/media/x/giphy.gif"')
  })

  it("keeps a video with its src and forces controls", () => {
    const out = sanitize(
      '<video src="/api/teams/media?url=vid" itemtype="http://schema.skype.com/AMSVideo" data-duration="PT27S">',
    )
    expect(out).toContain("<video")
    expect(out).toContain('src="/api/teams/media?url=vid"')
    expect(out).toContain("controls")
  })

  it("still strips a script even next to media", () => {
    const out = sanitize('<img src="/api/teams/media?url=x"><script>alert(1)</script>')
    expect(out).not.toContain("<script")
    expect(out).toContain("<img")
  })
})
