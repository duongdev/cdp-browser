import { describe, expect, it } from "vitest"
import { composeTitle, renderBody, toReaderMessages } from "./teams-render"

// A raw-ish Teams message (only the fields the renderer reads).
const msg = (over = {}) => ({
  id: "1700000000001",
  messagetype: "RichText/Html",
  content: "<p>hello team</p>",
  from: "https://x/v1/users/ME/contacts/8:orgid:AAA",
  imdisplayname: "Bob",
  originalarrivaltime: "2024-01-01T00:00:00.000Z",
  properties: {},
  ...over,
})

// renderBody now emits RICH HTML (t111): the site-authored Teams HTML is kept mention-resolved and
// entity-intact. It is NOT sanitized here — the renderer sanitizes with DOMPurify before it hits the
// DOM (sanitize-message.ts). So these tests assert markup is PRESERVED, not stripped.
describe("renderBody — rich HTML, mention-resolved", () => {
  it("keeps inline formatting tags", () => {
    expect(renderBody(msg({ content: "<p>hello <b>world</b></p>" }))).toBe(
      "<p>hello <b>world</b></p>",
    )
  })

  it("keeps links, lists and blockquotes", () => {
    const html = '<ul><li>a</li><li><a href="https://x.test">b</a></li></ul>'
    expect(renderBody(msg({ content: html }))).toBe(html)
  })

  it("resolves a legacy <at> mention to a stable span", () => {
    expect(renderBody(msg({ content: '<p>hi <at id="8:orgid:AAA">Alice</at>!</p>' }))).toBe(
      '<p>hi <span class="mention">@Alice</span>!</p>',
    )
  })

  it("resolves an itemtype mention span to the same stable span", () => {
    const html =
      '<p>ping <span itemscope itemtype="http://schema.skype.com/Mention" itemid="0">Bob Lee</span></p>'
    expect(renderBody(msg({ content: html }))).toBe(
      '<p>ping <span class="mention">@Bob Lee</span></p>',
    )
  })

  it("does not double-prefix an @ already in the mention text", () => {
    expect(renderBody(msg({ content: '<at id="0">@Al</at>' }))).toBe(
      '<span class="mention">@Al</span>',
    )
  })

  it('tags an emoji <img> with class="emoji" (attributes left for the sanitizer)', () => {
    const html = '<img itemtype="http://schema.skype.com/Emoji" alt="😄" src="e.png">seen'
    expect(renderBody(msg({ content: html }))).toBe(
      '<img class="emoji" itemtype="http://schema.skype.com/Emoji" alt="😄" src="e.png">seen',
    )
  })

  it("keeps HTML entities encoded (does not decode into new tags)", () => {
    expect(renderBody(msg({ content: "<p>a &amp; b &lt;3</p>" }))).toBe("<p>a &amp; b &lt;3</p>")
  })

  it("does NOT strip a <script> — sanitizing is the renderer's job, not this pure module", () => {
    expect(renderBody(msg({ content: "hi<script>alert(1)</script>bye" }))).toBe(
      "hi<script>alert(1)</script>bye",
    )
  })

  it("escapes a Text messagetype so its literal angle brackets render as text", () => {
    expect(renderBody(msg({ messagetype: "Text", content: "x < y & z" }))).toBe("x &lt; y &amp; z")
  })

  it("turns newlines in a Text messagetype into <br>", () => {
    expect(renderBody(msg({ messagetype: "Text", content: "a\nb" }))).toBe("a<br>b")
  })

  it("renders empty for a blank body", () => {
    expect(renderBody(msg({ content: "   " }))).toBe("")
  })

  it("keeps an emoji-only body (no text) instead of falling to a chip", () => {
    const html = '<img itemtype="http://schema.skype.com/Emoji" alt="😄" src="e.png">'
    expect(renderBody(msg({ content: html }))).toBe(
      '<img class="emoji" itemtype="http://schema.skype.com/Emoji" alt="😄" src="e.png">',
    )
  })
})

describe("renderBody — card / attachment chip", () => {
  it("returns [card] when properties.cards is present and no text", () => {
    expect(renderBody(msg({ content: "", properties: { cards: "[{...}]" } }))).toBe("[card]")
  })

  it("returns [attachment: name] from the first attachment when no text", () => {
    expect(renderBody(msg({ content: "", attachments: [{ name: "budget.xlsx" }] }))).toBe(
      "[attachment: budget.xlsx]",
    )
  })

  it("prefers real text over an attachment chip", () => {
    expect(renderBody(msg({ content: "<p>see file</p>", attachments: [{ name: "a" }] }))).toBe(
      "<p>see file</p>",
    )
  })

  it("falls to a chip when the HTML has no visible text", () => {
    expect(renderBody(msg({ content: "<p></p>", properties: { cards: "[{}]" } }))).toBe("[card]")
  })
})

describe("toReaderMessages", () => {
  it("shapes, resolves self by oid, sorts oldest-first, and carries HTML bodies", () => {
    const out = toReaderMessages(
      [
        msg({
          id: "2",
          originalarrivaltime: "2024-01-01T00:02:00.000Z",
          from: "https://x/8:orgid:ME",
          imdisplayname: "Me",
          content: "<p>second</p>",
        }),
        msg({
          id: "1",
          originalarrivaltime: "2024-01-01T00:01:00.000Z",
          content: "<p>first</p>",
        }),
      ],
      "ME",
    )
    expect(out.map((m) => m.id)).toEqual(["1", "2"])
    expect(out[0]).toMatchObject({
      id: "1",
      senderName: "Bob",
      body: "<p>first</p>",
      self: false,
      edited: false,
      deleted: false,
    })
    expect(out[1].self).toBe(true)
    expect(out[0].ts).toBe(Date.parse("2024-01-01T00:01:00.000Z"))
  })

  it("filters ThreadActivity/* system messages", () => {
    const out = toReaderMessages(
      [
        msg({ id: "1", content: "<p>real</p>" }),
        msg({ id: "sys", messagetype: "ThreadActivity/AddMember", content: "" }),
      ],
      "ME",
    )
    expect(out.map((m) => m.id)).toEqual(["1"])
  })

  it("marks a deleted message and shows the tombstone body", () => {
    const out = toReaderMessages(
      [msg({ id: "d", content: "", properties: { deletetime: "1700000000000" } })],
      "ME",
    )
    expect(out[0]).toMatchObject({ deleted: true, body: "message deleted", edited: false })
  })

  it("marks an edited message from properties.edittime", () => {
    const out = toReaderMessages(
      [msg({ id: "e", properties: { edittime: "1700000000000" } })],
      "ME",
    )
    expect(out[0].edited).toBe(true)
  })

  it("skips entries with no id and tolerates a null list", () => {
    expect(toReaderMessages(null, "ME")).toEqual([])
    expect(toReaderMessages([{ content: "x" }], "ME")).toEqual([])
  })

  it("matches self when from carries the full mri and selfId is the bare oid", () => {
    const out = toReaderMessages([msg({ from: "8:orgid:ME" })], "ME")
    expect(out[0].self).toBe(true)
  })
})

describe("composeTitle", () => {
  it("uses the topic when set", () => {
    expect(composeTitle({ topic: "Design sync", kind: "group" })).toBe("Design sync")
  })
  it("falls back by kind", () => {
    expect(composeTitle({ topic: null, kind: "oneOnOne" })).toBe("Direct message")
    expect(composeTitle({ topic: "  ", kind: "group" })).toBe("Group chat")
  })
})
