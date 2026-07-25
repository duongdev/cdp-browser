import { describe, expect, it } from "vitest"
import { buildGifContent, gifToOutgoing, giphyEntryToItem } from "./teams-gif"

const item = {
  id: "abc123",
  url: "https://media0.giphy.com/media/abc123/giphy.gif",
  previewUrl: "https://media0.giphy.com/media/abc123/200w.gif",
  width: 320,
  height: 240,
}

describe("buildGifContent", () => {
  it("emits the AnimatedImage wire schema", () => {
    const html = buildGifContent(item)
    expect(html).toContain('itemtype="http://schema.skype.com/AnimatedImage"')
    expect(html).toContain(`src="${item.url}"`)
    expect(html).toContain('id="abc123"')
    expect(html).toContain('width="320"')
    expect(html).toContain('height="240"')
  })
  it("escapes a hostile url/id and falls back on bad dimensions", () => {
    const html = buildGifContent({
      id: 'x"><script>',
      url: 'https://giphy.com/a.gif"><img>',
      previewUrl: "",
      width: 0,
      height: Number.NaN,
    })
    expect(html).not.toContain("<script>")
    expect(html).not.toContain('.gif"><img>')
    expect(html).toContain('width="220"')
    expect(html).toContain('height="220"')
  })
})

describe("gifToOutgoing", () => {
  it("is a RichText/Html send with no text or mentions", () => {
    const out = gifToOutgoing(item)
    expect(out.text).toBe("")
    expect(out.mentions).toEqual([])
    expect(out.html).toBe(out.displayHtml)
    expect(out.html).toContain("AnimatedImage")
  })
})

describe("giphyEntryToItem", () => {
  it("maps a Giphy entry, preferring fixed_width for the preview", () => {
    expect(
      giphyEntryToItem({
        id: "g1",
        images: {
          original: { url: "https://x/o.gif", width: "480", height: "270" },
          fixed_width: { url: "https://x/w.gif" },
        },
      }),
    ).toEqual({
      id: "g1",
      url: "https://x/o.gif",
      previewUrl: "https://x/w.gif",
      width: 480,
      height: 270,
    })
  })
  it("returns null without an id or original url", () => {
    expect(giphyEntryToItem({ images: { original: { url: "https://x/o.gif" } } })).toBeNull()
    expect(giphyEntryToItem({ id: "g1", images: {} })).toBeNull()
  })
})
