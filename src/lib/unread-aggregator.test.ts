import { describe, expect, it } from "vitest"
import { aggregateUnread } from "./unread-aggregator"

// A notification with just the fields the aggregator reads.
const notif = (over: Partial<Parameters<typeof aggregateUnread>[0][number]> = {}) => ({
  id: Math.random().toString(36).slice(2),
  read: false,
  targetUrl: "https://teams.microsoft.com/v2/",
  ...over,
})

describe("aggregateUnread", () => {
  describe("by-origin grouping", () => {
    it("shares one count across two tabs on the same origin (all-Teams case)", () => {
      const notifications = [notif(), notif()] // two unread Teams notifications
      const tabs = [
        { id: "t1", url: "https://teams.microsoft.com/v2/" },
        { id: "t2", url: "https://teams.microsoft.com/v2/chat" },
      ]

      const { byTab } = aggregateUnread(notifications, tabs, [], {})

      expect(byTab.t1).toBe(2)
      expect(byTab.t2).toBe(2)
    })

    it("does not bleed counts across origins", () => {
      const notifications = [
        notif({ targetUrl: "https://teams.microsoft.com/v2/" }),
        notif({ targetUrl: "https://outlook.office.com/mail/" }),
      ]
      const tabs = [
        { id: "teams", url: "https://teams.microsoft.com/v2/" },
        { id: "owa", url: "https://outlook.office.com/mail/inbox" },
      ]

      const { byTab, byGroup } = aggregateUnread(notifications, tabs, [], {})

      expect(byTab.teams).toBe(1)
      expect(byTab.owa).toBe(1)
      expect(byGroup["https://teams.microsoft.com"]).toBe(1)
      expect(byGroup["https://outlook.office.com"]).toBe(1)
    })
  })

  describe("read state", () => {
    it("excludes read notifications from every count", () => {
      const notifications = [notif({ read: true }), notif({ read: false }), notif({ read: true })]
      const tabs = [{ id: "t1", url: "https://teams.microsoft.com/v2/" }]

      const { byTab, byGroup } = aggregateUnread(notifications, tabs, [], {})

      expect(byTab.t1).toBe(1)
      expect(byGroup["https://teams.microsoft.com"]).toBe(1)
    })
  })

  describe("pins", () => {
    it("resolves a linked pin through its live linked tab's origin (drift)", () => {
      // Pin saved at Teams, but its linked tab has navigated to Outlook.
      const notifications = [notif({ targetUrl: "https://outlook.office.com/mail/" })]
      const pins = [{ id: "p1", url: "https://teams.microsoft.com/v2/", targetId: "x1" }]
      const linkedTabByPin = {
        p1: { id: "x1", url: "https://outlook.office.com/mail/inbox" },
      }

      const { byPin } = aggregateUnread(notifications, [], pins, linkedTabByPin)

      // Counts against the live tab's origin (Outlook), not the saved Teams URL.
      expect(byPin.p1).toBe(1)
    })

    it("resolves a dormant (unlinked) pin through its saved url origin", () => {
      const notifications = [notif({ targetUrl: "https://teams.microsoft.com/v2/" })]
      const pins = [{ id: "p1", url: "https://teams.microsoft.com/v2/" }]

      const { byPin } = aggregateUnread(notifications, [], pins, {})

      expect(byPin.p1).toBe(1)
    })
  })

  describe("unkeyable inputs", () => {
    it("does not throw and contributes/receives 0 for URLs with no origin", () => {
      const notifications = [
        notif({ targetUrl: undefined }),
        notif({ targetUrl: "not a url" }),
        notif({ targetUrl: "https://teams.microsoft.com/v2/" }),
      ]
      const tabs = [
        { id: "good", url: "https://teams.microsoft.com/v2/" },
        { id: "bad", url: "garbage" },
        { id: "missing", url: undefined as unknown as string },
      ]
      const pins = [{ id: "p-bad", url: "::::" }]

      const { byTab, byPin } = aggregateUnread(notifications, tabs, pins, {})

      expect(byTab.good).toBe(1)
      expect(byTab.bad).toBe(0)
      expect(byTab.missing).toBe(0)
      expect(byPin["p-bad"]).toBe(0)
    })
  })

  describe("groupKey forward-compat", () => {
    it("keys a notification on groupKey when present", () => {
      const notifications = [
        notif({ groupKey: "teams-workspace-A", targetUrl: "https://teams.microsoft.com/v2/" }),
      ]
      const tabs = [{ id: "t1", url: "https://teams.microsoft.com/v2/" }]

      const { byGroup, byTab } = aggregateUnread(notifications, tabs, [], {})

      // Counted under the explicit groupKey, not the origin.
      expect(byGroup["teams-workspace-A"]).toBe(1)
      expect(byGroup["https://teams.microsoft.com"]).toBeUndefined()
      // The tab keys on origin (no groupKey on tabs), so it does not match the
      // groupKey'd notification.
      expect(byTab.t1).toBe(0)
    })

    it("matches a tab whose resolved origin equals the notification groupKey", () => {
      // When a notification's groupKey happens to equal a tab's origin, they match.
      const origin = "https://teams.microsoft.com"
      const notifications = [notif({ groupKey: origin })]
      const tabs = [{ id: "t1", url: "https://teams.microsoft.com/v2/" }]

      const { byTab } = aggregateUnread(notifications, tabs, [], {})

      expect(byTab.t1).toBe(1)
    })
  })

  describe("slack multi-workspace (t064)", () => {
    // Every Slack workspace shares the app.slack.com origin, so the tab/pin must resolve
    // to its per-workspace `slack:{teamId}` bucket — not the shared origin — to badge.
    it("badges a Slack tab via its team-id bucket, not the shared origin", () => {
      const notifications = [
        notif({ groupKey: "slack:T111", targetUrl: "https://app.slack.com/client/T111/C1" }),
      ]
      const tabs = [{ id: "w1", url: "https://app.slack.com/client/T111/C9" }]

      const { byGroup, byTab } = aggregateUnread(notifications, tabs, [], {})

      expect(byGroup["slack:T111"]).toBe(1)
      expect(byTab.w1).toBe(1)
    })

    it("keeps two workspaces on app.slack.com distinct (no cross-bleed)", () => {
      const notifications = [
        notif({ groupKey: "slack:T111", targetUrl: "https://app.slack.com/client/T111/C1" }),
        notif({ groupKey: "slack:T222", targetUrl: "https://app.slack.com/client/T222/C1" }),
        notif({ groupKey: "slack:T222", targetUrl: "https://app.slack.com/client/T222/C2" }),
      ]
      const tabs = [
        { id: "w1", url: "https://app.slack.com/client/T111/C9" },
        { id: "w2", url: "https://app.slack.com/client/T222/C9" },
      ]

      const { byTab } = aggregateUnread(notifications, tabs, [], {})

      expect(byTab.w1).toBe(1)
      expect(byTab.w2).toBe(2)
    })

    it("resolves an Enterprise Grid (E-prefixed) workspace tab", () => {
      const notifications = [
        notif({ groupKey: "slack:E333", targetUrl: "https://app.slack.com/client/E333/C1" }),
      ]
      const tabs = [{ id: "w1", url: "https://app.slack.com/client/E333/C9" }]

      const { byTab } = aggregateUnread(notifications, tabs, [], {})

      expect(byTab.w1).toBe(1)
    })

    it("badges a dormant Slack pin by its saved workspace URL", () => {
      const notifications = [
        notif({ groupKey: "slack:T111", targetUrl: "https://app.slack.com/client/T111/C1" }),
      ]
      const pins = [{ id: "p1", url: "https://app.slack.com/client/T111/C2" }]

      const { byPin } = aggregateUnread(notifications, [], pins, {})

      expect(byPin.p1).toBe(1)
    })
  })
})
