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

  it("falls back when the preview is empty or tag-only", () => {
    expect(previewLine(conv({ lastMessagePreview: "" }))).toBe("No messages yet")
    expect(previewLine(conv({ lastMessagePreview: "<img src='x'>" }))).toBe("No messages yet")
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
