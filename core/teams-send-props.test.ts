import { describe, expect, it } from "vitest"

// @ts-expect-error — CJS module, no types
import { buildSendProperties, captionHtml } from "./teams-send-props.js"

describe("buildSendProperties — quotes", () => {
  it("returns an empty object when nothing is passed", () => {
    expect(buildSendProperties()).toEqual({})
    expect(buildSendProperties({})).toEqual({})
    expect(buildSendProperties({ quotes: [], mentions: [] })).toEqual({})
  })

  it("emits qtdMsgs + formatVariant + hasValidMsgReferences for a quoted reply", () => {
    const p = buildSendProperties({
      quotes: [{ messageId: 123, sender: "8:orgid:abc", time: 123 }],
    })
    expect(p.formatVariant).toBe("TEAMS")
    expect(p.hasValidMsgReferences).toBe(true)
    expect(p.qtdMsgs).toEqual([
      {
        messageId: 123,
        sender: "8:orgid:abc",
        time: 123,
        message: null,
        validationResult: "Valid",
        sharedRefId: null,
        replyChainId: null,
      },
    ])
  })

  it("carries every quote in order", () => {
    const p = buildSendProperties({
      quotes: [
        { messageId: 1, sender: "a", time: 1 },
        { messageId: 2, sender: "b", time: 2 },
      ],
    })
    expect(p.qtdMsgs.map((q: { messageId: number }) => q.messageId)).toEqual([1, 2])
  })
})

describe("buildSendProperties — mentions", () => {
  // `@type` + `mentionType` are load-bearing: an entry missing either is accepted (201) but
  // mentions nobody (PSN-120, verified against the `48:mentions` service oracle).
  it("serializes mentions as a JSON STRING with all five load-bearing fields", () => {
    const p = buildSendProperties({
      mentions: [{ itemid: 0, mri: "8:orgid:abc", displayName: "Dustin" }],
    })
    expect(typeof p.mentions).toBe("string")
    expect(JSON.parse(p.mentions)).toEqual([
      {
        "@type": "http://schema.skype.com/Mention",
        itemid: 0,
        mri: "8:orgid:abc",
        mentionType: "person",
        displayName: "Dustin",
      },
    ])
  })

  it("drops an entry missing an mri rather than sending a mention that notifies nobody", () => {
    const p = buildSendProperties({
      mentions: [
        { itemid: 0, mri: "", displayName: "Ghost" },
        { itemid: 1, mri: "8:orgid:real", displayName: "Real" },
      ],
    })
    const parsed = JSON.parse(p.mentions)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].mri).toBe("8:orgid:real")
  })

  it("omits the mentions key entirely when every entry is unusable", () => {
    const p = buildSendProperties({ mentions: [{ itemid: 0, mri: "", displayName: "Ghost" }] })
    expect(p.mentions).toBeUndefined()
  })

  it("merges quotes and mentions into one properties object", () => {
    const p = buildSendProperties({
      quotes: [{ messageId: 9, sender: "s", time: 9 }],
      mentions: [{ itemid: 0, mri: "8:orgid:abc", displayName: "D" }],
    })
    expect(p.qtdMsgs).toHaveLength(1)
    expect(typeof p.mentions).toBe("string")
  })

  it("passes extra properties through untouched (the file chip payload)", () => {
    const p = buildSendProperties({
      mentions: [{ itemid: 0, mri: "8:orgid:abc", displayName: "D" }],
      extra: { files: '[{"id":"x"}]' },
    })
    expect(p.files).toBe('[{"id":"x"}]')
    expect(typeof p.mentions).toBe("string")
  })
})

describe("captionHtml", () => {
  it("escapes a plain-text caption and converts newlines", () => {
    expect(captionHtml({ text: "a <b> & c\nd" })).toBe("a &lt;b&gt; &amp; c<br>d")
  })

  it("returns an empty string for blank or missing text", () => {
    expect(captionHtml({})).toBe("")
    expect(captionHtml({ text: "   " })).toBe("")
  })

  // The whole point of t182: an attachment caption must be able to carry mention spans, which
  // only survive if the caller's pre-built HTML is used verbatim instead of being escaped.
  it("prefers caller-supplied html over text so mention spans survive", () => {
    const html = '<span itemtype="http://schema.skype.com/Mention" itemid="0">Dustin</span> hi'
    expect(captionHtml({ text: "@Dustin hi", html })).toBe(html)
  })

  it("falls back to escaped text when html is blank", () => {
    expect(captionHtml({ text: "hey", html: "   " })).toBe("hey")
    expect(captionHtml({ text: "hey", html: null })).toBe("hey")
  })
})
