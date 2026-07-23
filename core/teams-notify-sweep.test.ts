import { describe, expect, it } from "vitest"
import { mentionsSelf, planTeamsNotifications } from "./teams-notify-sweep"

const SELF = "self-oid-123"
const selfFrom = `8:orgid:${SELF}`
const otherFrom = "8:orgid:other-oid-456"

// Minimal raw-normalized conversation (caller shapes ts to epoch ms before calling).
const conv = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  lastMessage: {
    id: "m1",
    from: otherFrom,
    imdisplayname: "Alice",
    content: "<p>hello there</p>",
    ts: 1000,
    messagetype: "RichText/Html",
    ...over,
  },
})

const seeded = { watermarks: {}, seeded: false }

describe("planTeamsNotifications", () => {
  it("seeds every watermark and emits nothing on the first (unseeded) run", () => {
    const { notifications, state } = planTeamsNotifications({
      conversations: [conv("19:a@unq.gbl.spaces"), conv("19:b@thread.v2", { ts: 2000 })],
      state: seeded,
      selfId: SELF,
    })
    expect(notifications).toEqual([])
    expect(state.seeded).toBe(true)
    expect(state.watermarks).toEqual({ "19:a@unq.gbl.spaces": 1000, "19:b@thread.v2": 2000 })
  })

  it("emits once for a newer incoming message and advances the watermark", () => {
    const state0 = { watermarks: { "19:a@unq.gbl.spaces": 1000 }, seeded: true }
    const { notifications, state } = planTeamsNotifications({
      conversations: [conv("19:a@unq.gbl.spaces", { id: "m2", ts: 2000, content: "<p>ping</p>" })],
      state: state0,
      selfId: SELF,
    })
    expect(notifications).toEqual([
      {
        convId: "19:a@unq.gbl.spaces",
        msgId: "m2",
        ts: 2000,
        senderName: "Alice",
        preview: "ping",
        mentionsMe: false,
      },
    ])
    expect(state.watermarks["19:a@unq.gbl.spaces"]).toBe(2000)
  })

  it("skips a self-authored newest message but still advances the watermark", () => {
    const state0 = { watermarks: { "19:a@unq.gbl.spaces": 1000 }, seeded: true }
    const { notifications, state } = planTeamsNotifications({
      conversations: [conv("19:a@unq.gbl.spaces", { ts: 2000, from: selfFrom })],
      state: state0,
      selfId: SELF,
    })
    expect(notifications).toEqual([])
    expect(state.watermarks["19:a@unq.gbl.spaces"]).toBe(2000)
  })

  it("skips system messages and reserved conversations", () => {
    const state0 = { watermarks: {}, seeded: true }
    const { notifications } = planTeamsNotifications({
      conversations: [
        conv("19:a@unq.gbl.spaces", { ts: 2000, messagetype: "ThreadActivity/AddMember" }),
        conv("48:notifications", { ts: 2000 }),
      ],
      state: state0,
      selfId: SELF,
    })
    expect(notifications).toEqual([])
  })

  it("skips a non-chat messagetype (image/file/control)", () => {
    const state0 = { watermarks: {}, seeded: true }
    const { notifications } = planTeamsNotifications({
      conversations: [
        conv("19:a@unq.gbl.spaces", { ts: 2000, messagetype: "RichText/Media_GenericFile" }),
      ],
      state: state0,
      selfId: SELF,
    })
    expect(notifications).toEqual([])
  })

  it("emits nothing on a second call with no change", () => {
    const state0 = { watermarks: { "19:a@unq.gbl.spaces": 1000 }, seeded: true }
    const { notifications, state } = planTeamsNotifications({
      conversations: [conv("19:a@unq.gbl.spaces")],
      state: state0,
      selfId: SELF,
    })
    expect(notifications).toEqual([])
    // Unchanged → the same state reference is returned (lets the caller skip the disk write).
    expect(state).toBe(state0)
  })

  it("does not re-emit on a ts tie (strict > gate)", () => {
    const state0 = { watermarks: { "19:a@unq.gbl.spaces": 1000 }, seeded: true }
    const { notifications } = planTeamsNotifications({
      conversations: [conv("19:a@unq.gbl.spaces", { ts: 1000 })],
      state: state0,
      selfId: SELF,
    })
    expect(notifications).toEqual([])
  })

  it("matches self by oid tail regardless of MRI format", () => {
    const state0 = { watermarks: {}, seeded: true }
    // from as a full contacts URL ending in the self MRI, selfId as the bare oid.
    const { notifications } = planTeamsNotifications({
      conversations: [
        conv("19:a@unq.gbl.spaces", {
          ts: 2000,
          from: `https://.../8:orgid:${SELF}`,
        }),
      ],
      state: state0,
      selfId: SELF,
    })
    expect(notifications).toEqual([])
  })

  it("renders a Text messagetype and caps the preview", () => {
    const long = "x".repeat(300)
    const state0 = { watermarks: {}, seeded: true }
    const { notifications } = planTeamsNotifications({
      conversations: [
        conv("19:a@unq.gbl.spaces", { ts: 2000, messagetype: "Text", content: long }),
      ],
      state: state0,
      selfId: SELF,
    })
    expect(notifications[0].preview.length).toBeLessThanOrEqual(141) // 140 + ellipsis
    expect(notifications[0].preview.endsWith("…")).toBe(true)
  })

  it("stamps mentionsMe when the content carries the self oid (t167)", () => {
    const state0 = { watermarks: {}, seeded: true }
    const { notifications } = planTeamsNotifications({
      conversations: [
        conv("19:a@unq.gbl.spaces", {
          ts: 2000,
          content: `<p><span itemtype="http://schema.skype.com/Mention" itemid="8:orgid:${SELF}">Me</span> look</p>`,
        }),
      ],
      state: state0,
      selfId: SELF,
    })
    expect(notifications[0].mentionsMe).toBe(true)
  })
})

describe("mentionsSelf (t167)", () => {
  it("true when the self oid appears in a mention tag, case-insensitive", () => {
    expect(mentionsSelf(`<at id="8:orgid:${SELF.toUpperCase()}">Me</at> hi`, SELF)).toBe(true)
  })

  it("false for other-oid content, empty content, or no selfId", () => {
    expect(mentionsSelf("<p>hello other-oid-456</p>", SELF)).toBe(false)
    expect(mentionsSelf("", SELF)).toBe(false)
    expect(mentionsSelf("<p>x</p>", "")).toBe(false)
  })

  it("accepts an 8:orgid: MRI selfId (normalized to the oid)", () => {
    expect(mentionsSelf(`<at id="8:orgid:${SELF}">Me</at>`, `8:orgid:${SELF}`)).toBe(true)
  })
})
