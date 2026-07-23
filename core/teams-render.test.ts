import { describe, expect, it } from "vitest"
import {
  composeTitle,
  parseAttachments,
  parseEmotions,
  previewText,
  renderBody,
  systemEventText,
  toReaderMessages,
} from "./teams-render"

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

// renderBody now emits RICH HTML (t133): the site-authored Teams HTML is kept mention-resolved and
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

// FIX A (t140): Teams splits one person's @mention into per-token spans (each name word its own
// itemtype-Mention span), and properties.mentions maps EVERY itemid of the run to the SAME mri. A
// run of adjacent same-person spans must collapse into ONE pill; two genuinely different people
// stay two pills; without the mentions prop nothing merges (distinct itemids → distinct keys).
describe("renderBody — mention run merging (t140)", () => {
  const span = (id, text) =>
    `<span itemscope itemtype="http://schema.skype.com/Mention" itemid="${id}">${text}</span>`

  it("merges a run of same-person spans into one pill with the joined name", () => {
    const mri = "8:orgid:aaaa-bbbb-798f77fe"
    const content = `<p>hi ${[span(0, "Glory"), span(1, "Nguyen"), span(2, "-"), span(3, "Group"), span(4, "Office"), span(5, "[C]")].join("&nbsp;")}</p>`
    const mentions = [0, 1, 2, 3, 4, 5].map((itemid) => ({ itemid, mri }))
    expect(renderBody(msg({ content, properties: { mentions } }))).toBe(
      '<p>hi <span class="mention">@Glory Nguyen - Group Office [C]</span></p>',
    )
  })

  it("merges when properties.mentions is a JSON string (the real Teams shape)", () => {
    const mri = "8:orgid:f89854b7-bc31-430f-ad88-723752d1c7dd"
    const content = `<p>Yo ${[span(0, "Careen"), span(1, "Tan"), span(2, "-"), span(3, "Group"), span(4, "Office")].join("&nbsp;")}</p>`
    const mentions = JSON.stringify([0, 1, 2, 3, 4].map((itemid) => ({ itemid, mri })))
    expect(renderBody(msg({ content, properties: { mentions } }))).toBe(
      '<p>Yo <span class="mention">@Careen Tan - Group Office</span></p>',
    )
  })

  it("keeps two genuinely different adjacent people as two pills", () => {
    const content = `${span(0, "Alice")} ${span(1, "Bob")}`
    const mentions = [
      { itemid: 0, mri: "8:orgid:alice" },
      { itemid: 1, mri: "8:orgid:bob" },
    ]
    expect(renderBody(msg({ content, properties: { mentions } }))).toBe(
      '<span class="mention">@Alice</span> <span class="mention">@Bob</span>',
    )
  })

  it("leaves a single mention unchanged", () => {
    const content = span(0, "Carol Ng")
    expect(
      renderBody(msg({ content, properties: { mentions: [{ itemid: 0, mri: "8:orgid:c" }] } })),
    ).toBe('<span class="mention">@Carol Ng</span>')
  })

  it("does not merge adjacent spans when properties.mentions is absent (distinct itemids)", () => {
    const content = `${span(0, "Glory")}&nbsp;${span(1, "Nguyen")}`
    expect(renderBody(msg({ content }))).toBe(
      '<span class="mention">@Glory</span>&nbsp;<span class="mention">@Nguyen</span>',
    )
  })

  it("still resolves legacy <at> mentions one pill each (no run split there)", () => {
    const content = '<at id="8:orgid:AAA">Alice</at> <at id="8:orgid:BBB">Bob</at>'
    expect(renderBody(msg({ content }))).toBe(
      '<span class="mention">@Alice</span> <span class="mention">@Bob</span>',
    )
  })
})

describe("renderBody — card / attachment chip", () => {
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
})

// t151 (grilled #7): an AdaptiveCard `properties.cards` (a JSON string) with no rendered body degrades
// to a styled generic card block — title + summary text extracted best-effort, NO adaptivecards dep,
// no card actions. Malformed/empty cards → a bare "Card" block. Real body text still wins over it.
describe("renderBody — adaptive-card generic fallback", () => {
  const cardMsg = (cards, over = {}) => msg({ content: "", properties: { cards }, ...over })

  it("extracts title + body text from an AdaptiveCard JSON string", () => {
    const cards = JSON.stringify([
      {
        content: {
          type: "AdaptiveCard",
          body: [
            { type: "TextBlock", text: "Deployment Succeeded" },
            { type: "TextBlock", text: "env: prod" },
          ],
        },
      },
    ])
    expect(renderBody(cardMsg(cards))).toBe(
      '<span class="teams-card"><span class="teams-card-title">Deployment Succeeded</span><span class="teams-card-body">env: prod</span></span>',
    )
  })

  it("strips markdown-ish markup and escapes HTML in extracted card text", () => {
    const cards = JSON.stringify([
      { content: { body: [{ text: "**Alert** <x>" }, { text: "see [here](http://x)" }] } },
    ])
    expect(renderBody(cardMsg(cards))).toBe(
      '<span class="teams-card"><span class="teams-card-title">Alert &lt;x&gt;</span><span class="teams-card-body">see here</span></span>',
    )
  })

  it("degrades a valid-but-textless card to a bare Card block", () => {
    expect(renderBody(cardMsg(JSON.stringify([{ content: {} }])))).toBe(
      '<span class="teams-card"><span class="teams-card-title">Card</span></span>',
    )
  })

  it("renders nothing for a malformed (unparseable) cards prop", () => {
    // A card we can't parse leaves no chip and no card block — the message renders empty rather than
    // fabricating a bogus "Card" out of garbage.
    expect(renderBody(cardMsg("{not json"))).toBe("")
  })

  it("prefers real body text over the card block", () => {
    const cards = JSON.stringify([{ content: { body: [{ text: "ignored" }] } }])
    expect(renderBody(cardMsg(cards, { content: "<p>here</p>" }))).toBe("<p>here</p>")
  })
})

// t151: any non-html messagetype whose content is unrecognized XML markup must not leak as escaped
// raw payload — a quiet "[unsupported: type]" chip instead. A plain "Text" body stays escaped.
describe("renderBody — unsupported non-html fallback", () => {
  it("does not leak raw XML from an unknown non-html messagetype", () => {
    expect(
      renderBody(
        msg({ messagetype: "RichText/Media_Unknown", content: "<weird><foo>bar</foo></weird>" }),
      ),
    ).toBe("[unsupported: RichText/Media_Unknown]")
  })

  it("still escapes a plain Text body (not treated as unsupported)", () => {
    expect(renderBody(msg({ messagetype: "Text", content: "a < b" }))).toBe("a &lt; b")
  })

  it("escapes a non-html body that isn't XML-ish", () => {
    expect(renderBody(msg({ messagetype: "RichText/Media_Unknown", content: "just text" }))).toBe(
      "just text",
    )
  })
})

// t151: system-event → compact line. Built from the LIVE-enumerated shapes (Event/Call, ThreadActivity/*).
describe("systemEventText (t151)", () => {
  const sysMsg = (over) => ({ properties: {}, ...over })

  it("summarizes an ended call with its participant count", () => {
    expect(
      systemEventText(
        sysMsg({
          messagetype: "Event/Call",
          content: '<ended/><partlist alt="" count="10"><part/></partlist>',
        }),
      ),
    ).toBe("Call ended · 10 people")
  })

  it("summarizes a 1-person ended call", () => {
    expect(
      systemEventText(
        sysMsg({ messagetype: "Event/Call", content: '<ended/><partlist count="1"/>' }),
      ),
    ).toBe("Call ended · 1 person")
  })

  it("skips a bare meeting placeholder (no <ended/>)", () => {
    expect(
      systemEventText(
        sysMsg({ messagetype: "Event/Call", content: "<partlist></partlist><meetingDetails/>" }),
      ),
    ).toBeNull()
  })

  it("names members joining from the event JSON friendlyname", () => {
    const content = JSON.stringify({
      eventtime: 1,
      members: [{ id: "8:x", friendlyname: "Haiyang" }],
    })
    expect(systemEventText(sysMsg({ messagetype: "ThreadActivity/MemberJoined", content }))).toBe(
      "Haiyang joined",
    )
  })

  it("reads a self-removal DeleteMember as 'left'", () => {
    const content =
      "<deletemember><target>8:orgid:a</target><initiator>8:orgid:a</initiator></deletemember>"
    expect(
      systemEventText(
        sysMsg({ messagetype: "ThreadActivity/DeleteMember", imdisplayname: "Bob", content }),
      ),
    ).toBe("Bob left")
  })

  it("reads a DeleteMember of another as 'removed a member'", () => {
    const content =
      "<deletemember><target>8:orgid:a</target><initiator>8:orgid:b</initiator></deletemember>"
    expect(
      systemEventText(
        sysMsg({ messagetype: "ThreadActivity/DeleteMember", imdisplayname: "Bob", content }),
      ),
    ).toBe("Bob removed a member")
  })

  it("renders a topic rename with the new name", () => {
    const content = "<topicupdate><value>Sprint Planning</value></topicupdate>"
    expect(
      systemEventText(
        sysMsg({ messagetype: "ThreadActivity/TopicUpdate", imdisplayname: "Ann", content }),
      ),
    ).toBe('Ann renamed the conversation to "Sprint Planning"')
  })

  it("renders an app-added event with the app name", () => {
    const content = "<AddCustomApp><targetName>Polls</targetName></AddCustomApp>"
    expect(
      systemEventText(
        sysMsg({ messagetype: "ThreadActivity/AddCustomApp", imdisplayname: "Al", content }),
      ),
    ).toBe("Al added the Polls app")
  })

  it("returns null for low-signal / unknown subtypes", () => {
    expect(
      systemEventText(
        sysMsg({ messagetype: "ThreadActivity/MeetingPolicyUpdated", content: "<x/>" }),
      ),
    ).toBeNull()
    expect(
      systemEventText(sysMsg({ messagetype: "ThreadActivity/PinnedItemsUpdate", content: "{}" })),
    ).toBeNull()
    expect(
      systemEventText(sysMsg({ messagetype: "RichText/Media_CallTranscript", content: "{}" })),
    ).toBeNull()
  })

  it("falls back to a generic actor when imdisplayname is absent", () => {
    const content = "<addmember><target>8:x</target></addmember>"
    expect(systemEventText(sysMsg({ messagetype: "ThreadActivity/AddMember", content }))).toBe(
      "Someone added a member",
    )
  })
})

// t151: the conversation-list preview must be clean plain text for EVERY enumerated last-message shape.
describe("previewText (t151)", () => {
  it("keeps a plain HTML message's text", () => {
    expect(previewText("<p>hello team</p>")).toBe("hello team")
  })

  it("drops a quoted-reply blockquote and keeps the replier's own words", () => {
    const content =
      '<p>Yeah, agentName is showing Agent.</p><blockquote itemscope itemtype="http://schema.skype.com/Reply" itemid="1"><strong itemprop="mri">Haiyang</strong><p itemprop="preview">Looks like passed through</p></blockquote>'
    expect(previewText(content)).toBe("Yeah, agentName is showing Agent.")
  })

  it("reduces a reply with no added text to the reply glyph + quoted preview", () => {
    const content =
      '<blockquote itemscope itemtype="http://schema.skype.com/Reply" itemid="1"><p itemprop="preview">original text</p></blockquote>'
    expect(previewText(content)).toBe("↩ original text")
  })

  it("reduces an ended-call payload to 'Call ended'", () => {
    expect(previewText('<ended/><partlist count="3"></partlist>')).toBe("Call ended")
  })

  it("reduces a topic-update payload to the rename line", () => {
    expect(previewText("<topicupdate><value>New Topic</value></topicupdate>")).toBe(
      'Renamed to "New Topic"',
    )
  })

  it("reduces a member-change payload to a generic line", () => {
    expect(previewText("<deletemember><target>8:x</target></deletemember>")).toBe(
      "Membership changed",
    )
  })

  it("reduces a SWIFT card to its Title", () => {
    expect(
      previewText('<URIObject type="SWIFT.1"><Title>Deployment Succeeded</Title></URIObject>'),
    ).toBe("Deployment Succeeded")
  })

  it("reduces a call recording to a label", () => {
    expect(
      previewText('<URIObject type="Video.2/CallRecording.1"><Title>Standup</Title></URIObject>'),
    ).toBe("Call recording")
  })

  it("returns empty for a noise system payload", () => {
    expect(
      previewText("<meetingpolicyupdated><value>ChatEnabled</value></meetingpolicyupdated>"),
    ).toBe("")
  })

  it("returns empty for a call-transcript JSON pointer (no leak)", () => {
    expect(previewText('{\\"scopeId\\":\\"abc\\",\\"callId\\":\\"def\\"}')).toBe("")
  })

  it("returns empty for empty content", () => {
    expect(previewText("")).toBe("")
    expect(previewText(null)).toBe("")
  })

  it("decodes entities and collapses whitespace", () => {
    expect(previewText("<p>a &amp; b\n  c</p>")).toBe("a & b c")
  })

  // t151 iteration 3: an inline image becomes a 📷 token — including a tag the store's 500-char
  // PREVIEW_CAP truncated mid-attribute (the live "okay… <img it…" leak — an unterminated tag that
  // the plain `<[^>]+>` strip can't remove); an emoji img keeps its alt char instead.
  it("turns an inline image into a 📷 token", () => {
    expect(
      previewText('<p>see <img itemtype="http://schema.skype.com/AMSImage" src="x"></p>'),
    ).toBe("see 📷")
    expect(previewText('<img src="x">')).toBe("📷")
  })

  it("tokenizes an img tag truncated mid-attribute by the preview cap", () => {
    expect(
      previewText('<p>okay - this was all I asked <img itemtype="http://schema.skype.com/AMSIm'),
    ).toBe("okay - this was all I asked 📷")
  })

  it("keeps an emoji img's alt char instead of the 📷 token", () => {
    expect(
      previewText('yes <img itemtype="http://schema.skype.com/Emoji" alt="😄" src="e.png"> ok'),
    ).toBe("yes 😄 ok")
  })

  it("drops any other tag truncated mid-attribute (no partial-markup leak)", () => {
    expect(previewText('<p>done</p><a href="https://x.test/very/long/pa')).toBe("done")
  })
})

// t141: file attachments + call-recording / Swift-card chips. `properties.files` arrives as a JSON
// STRING (like properties.mentions), so it MUST be parsed defensively. Call-recording + Swift cards
// live as <URIObject> blocks in `content` whose inner text renders as garbage — parse them into
// chips and strip the block from the rendered body. AMS thumbnails route through the media proxy.
describe("parseAttachments — files (JSON-string properties.files)", () => {
  const fileMsg = (files) => msg({ content: "<p>here</p>", properties: { files } })

  it("parses a file from a JSON-STRING properties.files, best url = fileInfo.shareUrl", () => {
    const files = JSON.stringify([
      {
        "@type": "http://schema.skype.com/File",
        fileName: "[GU-1933] Results.pdf",
        fileType: "pdf",
        title: "Results",
        objectUrl: "https://fwdgroup-my.sharepoint.com/x/file.pdf",
        fileInfo: {
          fileUrl: "https://fwdgroup-my.sharepoint.com/x/fileUrl.pdf",
          shareUrl: "https://fwdgroup-my.sharepoint.com/:b:/g/personal/share",
        },
      },
    ])
    expect(parseAttachments(fileMsg(files))).toEqual([
      {
        kind: "file",
        name: "[GU-1933] Results.pdf",
        type: "pdf",
        url: "https://fwdgroup-my.sharepoint.com/:b:/g/personal/share",
      },
    ])
  })

  it("falls back to objectUrl when there is no shareUrl", () => {
    const files = JSON.stringify([
      { fileName: "a.docx", fileType: "docx", objectUrl: "https://sp/obj", fileInfo: {} },
    ])
    expect(parseAttachments(fileMsg(files))[0].url).toBe("https://sp/obj")
  })

  it("falls back to fileInfo.fileUrl when there is no shareUrl or objectUrl", () => {
    const files = JSON.stringify([
      { fileName: "b.txt", fileInfo: { fileUrl: "https://sp/fileUrl" } },
    ])
    expect(parseAttachments(fileMsg(files))[0].url).toBe("https://sp/fileUrl")
  })

  it("tolerates an already-parsed properties.files array", () => {
    const files = [{ fileName: "c.pdf", fileType: "pdf", objectUrl: "https://sp/c" }]
    expect(parseAttachments(fileMsg(files))).toEqual([
      { kind: "file", name: "c.pdf", type: "pdf", url: "https://sp/c" },
    ])
  })

  it("returns no attachments when properties.files is absent, empty, or malformed", () => {
    expect(parseAttachments(msg({ content: "<p>hi</p>" }))).toEqual([])
    expect(parseAttachments(fileMsg("[]"))).toEqual([])
    expect(parseAttachments(fileMsg("{not json"))).toEqual([])
  })
})

describe("parseAttachments — call recording / Swift card (URIObject)", () => {
  it("extracts a call recording and proxies its AMS thumbnail", () => {
    const content =
      '<URIObject type="Video.2/CallRecording.1" url_thumbnail="https://as-prod.asyncgw.teams.microsoft.com/v1/objects/0-wus-d1-abc/views/thumbnail_small"><RecordingStatus status="viewable"></RecordingStatus></URIObject>'
    expect(parseAttachments(msg({ content }))).toEqual([
      {
        kind: "recording",
        thumbnailUrl:
          "/api/teams/media?url=https%3A%2F%2Fas-prod.asyncgw.teams.microsoft.com%2Fv1%2Fobjects%2F0-wus-d1-abc%2Fviews%2Fthumbnail_small",
      },
    ])
  })

  it("extracts a Swift card with its Title and proxied AMS thumbnail", () => {
    const content =
      '<URIObject type="SWIFT.1" url_thumbnail="https://as-prod.asyncgw.teams.microsoft.com/v1/objects/card-thumb/views/imgpsh"><Title>Weekly digest</Title><Swift b64="eyto="></Swift></URIObject>'
    expect(parseAttachments(msg({ content }))).toEqual([
      {
        kind: "card",
        title: "Weekly digest",
        thumbnailUrl:
          "/api/teams/media?url=https%3A%2F%2Fas-prod.asyncgw.teams.microsoft.com%2Fv1%2Fobjects%2Fcard-thumb%2Fviews%2Fimgpsh",
      },
    ])
  })

  it("leaves a non-AMS card thumbnail unproxied and defaults a missing Title to Card", () => {
    const content =
      '<URIObject type="SWIFT.1" url_thumbnail="https://urlp.asm.skype.com/preview.png"><Swift b64="x"></Swift></URIObject>'
    expect(parseAttachments(msg({ content }))).toEqual([
      { kind: "card", title: "Card", thumbnailUrl: "https://urlp.asm.skype.com/preview.png" },
    ])
  })
})

describe("renderBody — URIObject blocks (t141)", () => {
  it("renders empty for a call-recording-only body (no garbled inner text)", () => {
    const content =
      '<URIObject type="Video.2/CallRecording.1" url_thumbnail="https://as-prod.asyncgw.teams.microsoft.com/v1/objects/x/views/thumbnail_small">Card - access it on go.skype.com/cards.unsupported</URIObject>'
    expect(renderBody(msg({ content }))).toBe("")
  })

  it("renders empty for a Swift-card-only body", () => {
    const content =
      '<URIObject type="SWIFT.1"><Title>Card</Title><Swift b64="x"></Swift></URIObject>'
    expect(renderBody(msg({ content }))).toBe("")
  })

  it("keeps real text but strips the URIObject block", () => {
    const content =
      '<p>watch this</p><URIObject type="Video.2/CallRecording.1" url_thumbnail="https://x">junk</URIObject>'
    expect(renderBody(msg({ content }))).toBe("<p>watch this</p>")
  })
})

describe("toReaderMessages — attachments", () => {
  it("attaches parsed attachments to a message with a file", () => {
    const files = JSON.stringify([
      { fileName: "d.pdf", fileType: "pdf", objectUrl: "https://sp/d" },
    ])
    const out = toReaderMessages(
      [msg({ id: "1", content: "<p>doc</p>", properties: { files } })],
      "ME",
    )
    expect(out[0].attachments).toEqual([
      { kind: "file", name: "d.pdf", type: "pdf", url: "https://sp/d" },
    ])
  })

  it("omits attachments when there are none", () => {
    const out = toReaderMessages([msg({ id: "1", content: "<p>plain</p>" })], "ME")
    expect(out[0].attachments).toBeUndefined()
  })
})

describe("parseEmotions", () => {
  const emo = (over) => ({ properties: {}, ...over })

  it("parses an array of emotions → reactions with count + emoji", () => {
    const message = emo({
      properties: {
        emotions: [
          { key: "like", users: [{ mri: "8:orgid:A" }, { mri: "8:orgid:B" }] },
          { key: "heart", users: [{ mri: "8:orgid:C" }] },
        ],
      },
    })
    expect(parseEmotions(message, "ME")).toEqual([
      { key: "like", emoji: "👍", count: 2, mine: false, userMris: ["8:orgid:A", "8:orgid:B"] },
      { key: "heart", emoji: "❤️", count: 1, mine: false, userMris: ["8:orgid:C"] },
    ])
  })

  it("parses emotions delivered as a JSON string (the t140 mention trap)", () => {
    const message = emo({
      properties: {
        emotions: JSON.stringify([{ key: "laugh", users: [{ mri: "8:orgid:X" }] }]),
      },
    })
    expect(parseEmotions(message, "ME")).toEqual([
      { key: "laugh", emoji: "😆", count: 1, mine: false, userMris: ["8:orgid:X"] },
    ])
  })

  it("sets mine when the self oid is among the reactors' mris", () => {
    const message = emo({
      properties: {
        emotions: [{ key: "like", users: [{ mri: "8:orgid:A" }, { mri: "8:orgid:ME" }] }],
      },
    })
    expect(parseEmotions(message, "ME")).toEqual([
      { key: "like", emoji: "👍", count: 2, mine: true, userMris: ["8:orgid:A", "8:orgid:ME"] },
    ])
  })

  it("collects reactor MRIs into userMris, capped at 25 while count stays exact", () => {
    const users = Array.from({ length: 40 }, (_, i) => ({ mri: `8:orgid:U${i}` }))
    const [r] = parseEmotions(emo({ properties: { emotions: [{ key: "like", users }] } }), "ME")
    expect(r.count).toBe(40)
    expect(r.userMris).toHaveLength(25)
    expect(r.userMris[0]).toBe("8:orgid:U0")
  })

  it("drops a key whose users list is empty (nobody reacts)", () => {
    const message = emo({
      properties: {
        emotions: [
          { key: "like", users: [] },
          { key: "heart", users: [{ mri: "8:orgid:A" }] },
        ],
      },
    })
    expect(parseEmotions(message, "ME").map((r) => r.key)).toEqual(["heart"])
  })

  it("returns [] for missing / malformed emotions", () => {
    expect(parseEmotions(emo({}), "ME")).toEqual([])
    expect(parseEmotions(emo({ properties: { emotions: "{not json" } }), "ME")).toEqual([])
    expect(
      parseEmotions(emo({ properties: { emotions: [{ users: [{ mri: "x" }] }] } }), "ME"),
    ).toEqual([])
  })
})

describe("toReaderMessages — reactions", () => {
  it("attaches reactions to a message that has emotions", () => {
    const out = toReaderMessages(
      [
        msg({
          id: "1",
          content: "<p>hi</p>",
          properties: { emotions: [{ key: "like", users: [{ mri: "8:orgid:ME" }] }] },
        }),
      ],
      "ME",
    )
    expect(out[0].reactions).toEqual([
      { key: "like", emoji: "👍", count: 1, mine: true, userMris: ["8:orgid:ME"] },
    ])
  })

  it("omits reactions when there are none (or all keys are empty)", () => {
    const out = toReaderMessages([msg({ id: "1", content: "<p>plain</p>" })], "ME")
    expect(out[0].reactions).toBeUndefined()
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

  it("renders a recognized ThreadActivity as a system line (t151)", () => {
    const out = toReaderMessages(
      [
        msg({ id: "1", content: "<p>real</p>" }),
        msg({
          id: "sys",
          messagetype: "ThreadActivity/AddMember",
          imdisplayname: "Alice",
          content: "<addmember><target>8:orgid:x</target></addmember>",
        }),
      ],
      "ME",
    )
    const sys = out.find((m) => m.id === "sys")
    expect(sys).toMatchObject({ kind: "system", body: "Alice added a member" })
    expect(out.find((m) => m.id === "1")).toMatchObject({ body: "<p>real</p>" })
  })

  it("still skips a low-signal ThreadActivity subtype (t151)", () => {
    const out = toReaderMessages(
      [
        msg({ id: "1", content: "<p>real</p>" }),
        msg({
          id: "sys",
          messagetype: "ThreadActivity/MeetingPolicyUpdated",
          content: "<meetingpolicyupdated><value>ChatEnabled</value></meetingpolicyupdated>",
        }),
      ],
      "ME",
    )
    expect(out.map((m) => m.id)).toEqual(["1"])
  })

  it("does not carry self/edited/reaction fields on a system message", () => {
    const [sys] = toReaderMessages(
      [
        msg({
          id: "s",
          messagetype: "ThreadActivity/TopicUpdate",
          content: "<topicupdate><value>New</value></topicupdate>",
        }),
      ],
      "ME",
    )
    expect(sys.kind).toBe("system")
    expect(sys.self).toBeUndefined()
    expect(sys.reactions).toBeUndefined()
    expect(sys.attachments).toBeUndefined()
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

  it("leaves senderName empty when Teams omits imdisplayname — never 'Unknown' (t151)", () => {
    const out = toReaderMessages([msg({ imdisplayname: undefined })], "ME")
    expect(out[0].senderName).toBe("")
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
