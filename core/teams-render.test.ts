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

describe("renderBody — HTML → safe plain text", () => {
  it("strips tags, keeping the visible text", () => {
    expect(renderBody(msg({ content: "<p>hello <b>world</b></p>" }))).toBe("hello world")
  })

  it("keeps an <at> mention's display name", () => {
    expect(renderBody(msg({ content: '<p>hi <at id="8:orgid:AAA">Alice</at>!</p>' }))).toBe(
      "hi Alice!",
    )
  })

  it("removes <script> element AND its content (no leak)", () => {
    expect(renderBody(msg({ content: "hi<script>alert('x')</script>bye" }))).toBe("hibye")
  })

  it("removes <style> element AND its content", () => {
    expect(renderBody(msg({ content: "a<style>.x{color:red}</style>b" }))).toBe("ab")
  })

  it("drops event-handler attributes and javascript: urls (tags stripped entirely)", () => {
    expect(renderBody(msg({ content: '<img src=x onerror="alert(1)">seen' }))).toBe("seen")
    expect(renderBody(msg({ content: '<a href="javascript:alert(1)">click</a>' }))).toBe("click")
  })

  it("decodes HTML entities (named, numeric, hex)", () => {
    expect(renderBody(msg({ content: "a &amp; b &lt;3 &#39;q&#39; &#x41;" }))).toBe(
      "a & b <3 'q' A",
    )
  })

  it("does not double-decode &amp;lt;", () => {
    expect(renderBody(msg({ content: "&amp;lt;" }))).toBe("&lt;")
  })

  it("collapses whitespace across block tags and newlines", () => {
    expect(renderBody(msg({ content: "<div>one</div>\n<div>two</div>" }))).toBe("one two")
    expect(renderBody(msg({ content: "a<br>b<br/>c" }))).toBe("a b c")
  })

  it("renders a Text messagetype without tag-stripping its literal angle brackets", () => {
    expect(renderBody(msg({ messagetype: "Text", content: "x < y and z" }))).toBe("x < y and z")
  })

  it("renders empty for a blank body", () => {
    expect(renderBody(msg({ content: "   " }))).toBe("")
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
      "see file",
    )
  })
})

describe("toReaderMessages", () => {
  it("shapes, resolves self by oid, and sorts oldest-first", () => {
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
      body: "first",
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
