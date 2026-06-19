import { describe, expect, it } from "vitest"
import { buildNotificationContent, NOTIFICATION_FALLBACK_TAG } from "./push-notification"

describe("buildNotificationContent", () => {
  it("renders valid notification data with all fields", () => {
    const data = {
      id: "slack:team1:channel1:ts123",
      title: "Alice",
      body: "Hey there",
      icon: "/icons/slack.png",
      source: "slack",
      targetId: "target1",
      targetUrl: "https://slack.com/archives/C123",
      adapter: "slack",
      groupKey: "slack:team1",
      activate: { type: "spa-link" as const, url: "/client/team1/channel1" },
      ts: 1718000000000,
      unread: 3,
    }
    const result = buildNotificationContent(data)
    expect(result.title).toBe("Alice")
    expect(result.options.body).toBe("Hey there")
    expect(result.options.tag).toBe("slack:team1:channel1:ts123")
    expect(result.options.icon).toBe("/icons/slack.png")
    expect(result.options.badge).toBe("/icons/icon-192.png")
    expect((result.options as any).timestamp).toBe(1718000000000)
    expect(result.options.data).toEqual(data)
  })

  it("falls back to 'CDP Browser' title when data.title is missing", () => {
    const data = {
      id: "notif1",
      body: "Message",
      source: "slack",
      targetId: "t1",
    }
    const result = buildNotificationContent(data as any)
    expect(result.title).toBe("CDP Browser")
    expect(result.options.body).toBe("Message")
  })

  it("uses generic fallback notification for null data", () => {
    const result = buildNotificationContent(null)
    expect(result.title).toBe("New message")
    expect(result.options.body).toBe("")
    expect(result.options.tag).toBe(NOTIFICATION_FALLBACK_TAG)
    expect(result.options.data).toEqual({})
  })

  it("uses generic fallback notification for undefined data", () => {
    const result = buildNotificationContent(undefined)
    expect(result.title).toBe("New message")
    expect(result.options.body).toBe("")
    expect(result.options.tag).toBe(NOTIFICATION_FALLBACK_TAG)
  })

  it("accepts empty object and uses defaults for missing fields", () => {
    const result = buildNotificationContent({} as any)
    expect(result.title).toBe("CDP Browser")
    expect(result.options.body).toBe("")
    expect(result.options.tag).toBeUndefined()
  })

  it("preserves deep-route data (activate, targetId, channelId, etc.)", () => {
    const data = {
      id: "teams:123:456",
      title: "Teams",
      body: "Reply",
      source: "teams",
      targetId: "target1",
      adapter: "teams",
      activate: { type: "thread" as const, id: "msg123" },
      channelId: "ch123",
      slackKind: "channel",
      slackTs: "1234567890.000100",
      slackThreadTs: "1234567890.000100",
      ts: 1718000000000,
    }
    const result = buildNotificationContent(data as any)
    expect(result.options.data).toEqual(data)
  })

  it("uses current timestamp when data.ts is missing", () => {
    const before = Date.now()
    const data = {
      id: "notif1",
      title: "Test",
      body: "msg",
      source: "slack",
      targetId: "t1",
    }
    const result = buildNotificationContent(data as any)
    const after = Date.now()
    expect((result.options as any).timestamp).toBeGreaterThanOrEqual(before)
    expect((result.options as any).timestamp).toBeLessThanOrEqual(after)
  })

  it("always includes badge for consistency across platforms", () => {
    const data = {
      id: "notif1",
      title: "Test",
      body: "msg",
      source: "slack",
      targetId: "t1",
    }
    const result = buildNotificationContent(data as any)
    expect(result.options.badge).toBe("/icons/icon-192.png")
  })
})
