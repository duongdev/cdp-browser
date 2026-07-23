import { describe, expect, it } from "vitest"
import { conversationLabel, previewLine, relativeTime } from "./conversation-view"
import type { TeamsConversation } from "./teams-client"

const conv = (over: Partial<TeamsConversation>): TeamsConversation => ({
  id: "19:abc@unq.gbl.spaces",
  kind: "oneOnOne",
  topic: null,
  lastMessageId: null,
  lastMessageVersion: 0,
  lastMessageTs: null,
  lastMessagePreview: "",
  muted: false,
  ...over,
})

describe("conversationLabel", () => {
  it("prefers the resolved title over the topic (t131)", () => {
    expect(conversationLabel(conv({ title: "Alice, Bob", topic: "Release planning" }))).toBe(
      "Alice, Bob",
    )
  })

  it("falls back to the topic when the title is blank/absent", () => {
    expect(conversationLabel(conv({ title: "  ", topic: "Release planning" }))).toBe(
      "Release planning",
    )
  })

  it("uses the topic when present", () => {
    expect(conversationLabel(conv({ topic: "Release planning" }))).toBe("Release planning")
  })

  it("trims a topic and ignores a blank one", () => {
    expect(conversationLabel(conv({ topic: "  Standup  " }))).toBe("Standup")
    expect(conversationLabel(conv({ topic: "   ", kind: "group" }))).toBe("Group chat")
  })

  it("falls back by kind when there is no topic", () => {
    expect(conversationLabel(conv({ topic: null, kind: "oneOnOne" }))).toBe("Direct message")
    expect(conversationLabel(conv({ topic: null, kind: "group" }))).toBe("Group chat")
    expect(conversationLabel(conv({ topic: null, kind: "self" }))).toBe("Notes")
  })
})

describe("previewLine", () => {
  it("returns the trimmed preview text", () => {
    expect(previewLine(conv({ lastMessagePreview: "  hey there  " }))).toBe("hey there")
  })

  it("strips HTML tags and collapses whitespace", () => {
    expect(previewLine(conv({ lastMessagePreview: "<p>hi <b>team</b></p>\n\n done" }))).toBe(
      "hi team done",
    )
  })

  it("falls back when the preview is empty", () => {
    expect(previewLine(conv({ lastMessagePreview: "" }))).toBe("No messages yet")
  })

  // t151: an inline image becomes a 📷 token — including a tag the store's 500-char cap truncated
  // mid-attribute (the live "okay… <img it…" leak); an emoji img keeps its alt char.
  it("turns inline images into a 📷 token", () => {
    expect(previewLine(conv({ lastMessagePreview: "<img src='x'>" }))).toBe("📷")
    expect(
      previewLine(
        conv({
          lastMessagePreview:
            '<p>okay - this was all I asked <img itemtype="http://schema.skype.com/AMSImage" src="https://as-api.asm.skype.com/v1/objects/x/views/imgo"',
        }),
      ),
    ).toBe("okay - this was all I asked 📷")
    expect(
      previewLine(
        conv({
          lastMessagePreview:
            'yes <img itemtype="http://schema.skype.com/Emoji" alt="😄" src="e.png"> done',
        }),
      ),
    ).toBe("yes 😄 done")
  })

  // t151: the raw last-message content can be a quoted reply, a system event, or a card — the preview
  // must be clean plain text for every shape (mirrors core/teams-render.js previewText).
  it("drops a quoted-reply blockquote, keeping the replier's own words", () => {
    const raw =
      '<p>on it</p><blockquote itemscope itemtype="http://schema.skype.com/Reply"><p itemprop="preview">the original</p></blockquote>'
    expect(previewLine(conv({ lastMessagePreview: raw }))).toBe("on it")
  })

  it("reduces system events and cards to clean labels", () => {
    expect(previewLine(conv({ lastMessagePreview: '<ended/><partlist count="3"/>' }))).toBe(
      "Call ended",
    )
    expect(
      previewLine(conv({ lastMessagePreview: "<topicupdate><value>Sprint</value></topicupdate>" })),
    ).toBe('Renamed to "Sprint"')
    expect(
      previewLine(
        conv({ lastMessagePreview: '<URIObject type="SWIFT.1"><Title>Deploy</Title></URIObject>' }),
      ),
    ).toBe("Deploy")
    expect(
      previewLine(
        conv({
          lastMessagePreview: "<meetingpolicyupdated><value>x</value></meetingpolicyupdated>",
        }),
      ),
    ).toBe("No messages yet")
    expect(
      previewLine(conv({ lastMessagePreview: '{\\"scopeId\\":\\"a\\",\\"callId\\":\\"b\\"}' })),
    ).toBe("No messages yet")
  })
})

describe("relativeTime", () => {
  const now = 1_700_000_000_000

  it("returns an empty string for a missing timestamp", () => {
    expect(relativeTime(null, now)).toBe("")
  })

  it("buckets recent times", () => {
    expect(relativeTime(now - 5_000, now)).toBe("now")
    expect(relativeTime(now - 3 * 60_000, now)).toBe("3m")
    expect(relativeTime(now - 2 * 3_600_000, now)).toBe("2h")
    expect(relativeTime(now - 4 * 86_400_000, now)).toBe("4d")
  })

  it("returns a non-empty absolute label past a week", () => {
    expect(relativeTime(now - 30 * 86_400_000, now).length).toBeGreaterThan(0)
  })
})
