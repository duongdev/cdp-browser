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

  describe("enterprise grid teamGroupMap (t092)", () => {
    // The sweep stamps notifications with the merged `slack:{groupId}` groupKey already, so the
    // map is only for resolving a Tab/Pin URL (which carries the concrete teamId) to its bucket.
    it("buckets two Grid tabs of one org into the merged group via the map", () => {
      // Org pseudo-team E0 and member workspace TGF both map to groupId E0; one notification
      // arrives keyed at the merged bucket.
      const teamGroupMap = { E0EXAMPLE01: "E0EXAMPLE01", T0EXAMPLE01: "E0EXAMPLE01" }
      const notifications = [
        notif({
          groupKey: "slack:E0EXAMPLE01",
          targetUrl: "https://app.slack.com/client/T0EXAMPLE01/C1",
        }),
      ]
      const tabs = [
        { id: "org", url: "https://app.slack.com/client/E0EXAMPLE01/C9" },
        { id: "ws", url: "https://app.slack.com/client/T0EXAMPLE01/C9" },
      ]

      const { byTab, byGroup } = aggregateUnread(notifications, tabs, [], {}, teamGroupMap)

      expect(byGroup["slack:E0EXAMPLE01"]).toBe(1)
      // Both the org tab and the member-workspace tab resolve to the merged bucket.
      expect(byTab.org).toBe(1)
      expect(byTab.ws).toBe(1)
    })

    it("resolves a dormant Grid pin through the map to the merged bucket", () => {
      const teamGroupMap = { T0EXAMPLE01: "E0EXAMPLE01" }
      const notifications = [
        notif({
          groupKey: "slack:E0EXAMPLE01",
          targetUrl: "https://app.slack.com/client/E0EXAMPLE01/C1",
        }),
      ]
      const pins = [{ id: "p1", url: "https://app.slack.com/client/T0EXAMPLE01/C2" }]

      const { byPin } = aggregateUnread(notifications, [], pins, {}, teamGroupMap)

      expect(byPin.p1).toBe(1)
    })

    it("falls back to slack:{teamId} with no map entry (today's behavior)", () => {
      // standalone workspace: no map entry → groupId === teamId, byte-unchanged.
      const teamGroupMap = { T0EXAMPLE01: "E0EXAMPLE01" }
      const notifications = [
        notif({
          groupKey: "slack:T0EXAMPLE02",
          targetUrl: "https://app.slack.com/client/T0EXAMPLE02/C1",
        }),
      ]
      const tabs = [{ id: "ws2", url: "https://app.slack.com/client/T0EXAMPLE02/C9" }]

      const { byTab } = aggregateUnread(notifications, tabs, [], {}, teamGroupMap)

      expect(byTab.ws2).toBe(1)
    })

    it("is byte-unchanged when no map is passed (omitted arg)", () => {
      const notifications = [
        notif({ groupKey: "slack:T111", targetUrl: "https://app.slack.com/client/T111/C1" }),
      ]
      const tabs = [{ id: "w1", url: "https://app.slack.com/client/T111/C9" }]

      const { byTab } = aggregateUnread(notifications, tabs, [], {})

      expect(byTab.w1).toBe(1)
    })
  })

  describe("per-device mutes (t093)", () => {
    it("is byte-unchanged when no mutes option is passed", () => {
      const notifications = [
        notif({ adapter: "teams", targetUrl: "https://teams.microsoft.com/v2/" }),
        notif({ adapter: "outlook", targetUrl: "https://outlook.office.com/mail/" }),
      ]
      const tabs = [
        { id: "teams", url: "https://teams.microsoft.com/v2/" },
        { id: "owa", url: "https://outlook.office.com/mail/inbox" },
      ]

      const { byTab } = aggregateUnread(notifications, tabs, [], {}, {})

      expect(byTab.teams).toBe(1)
      expect(byTab.owa).toBe(1)
    })

    it("excludes a muted adapter (Teams) from byGroup and byTab", () => {
      const notifications = [
        notif({ adapter: "teams", targetUrl: "https://teams.microsoft.com/v2/" }),
        notif({ adapter: "outlook", targetUrl: "https://outlook.office.com/mail/" }),
      ]
      const tabs = [
        { id: "teams", url: "https://teams.microsoft.com/v2/" },
        { id: "owa", url: "https://outlook.office.com/mail/inbox" },
      ]

      const { byTab, byGroup } = aggregateUnread(
        notifications,
        tabs,
        [],
        {},
        {},
        {
          mutes: ["teams"],
          master: true,
        },
      )

      expect(byTab.teams).toBe(0)
      expect(byTab.owa).toBe(1)
      expect(byGroup["https://teams.microsoft.com"]).toBeUndefined()
    })

    it("excludes a muted Slack workspace by its groupKey", () => {
      // Both notifications carry the merged groupKey (E1/E2); the tab URLs carry the
      // concrete teamId (T1/T2), resolved to the merged bucket via the teamGroupMap (t092).
      const teamGroupMap = { T1: "E1", T2: "E2" }
      const notifications = [
        notif({
          adapter: "slack",
          groupKey: "slack:E1",
          targetUrl: "https://app.slack.com/client/T1/C1",
        }),
        notif({
          adapter: "slack",
          groupKey: "slack:E2",
          targetUrl: "https://app.slack.com/client/T2/C1",
        }),
      ]
      const tabs = [
        { id: "w1", url: "https://app.slack.com/client/T1/C9" },
        { id: "w2", url: "https://app.slack.com/client/T2/C9" },
      ]

      const { byTab } = aggregateUnread(notifications, tabs, [], {}, teamGroupMap, {
        mutes: ["slack:E1"],
        master: true,
      })

      expect(byTab.w1).toBe(0)
      expect(byTab.w2).toBe(1)
    })

    it("zeroes every count when the device master is off", () => {
      const notifications = [
        notif({ adapter: "teams", targetUrl: "https://teams.microsoft.com/v2/" }),
        notif({ adapter: "outlook", targetUrl: "https://outlook.office.com/mail/" }),
      ]
      const tabs = [
        { id: "teams", url: "https://teams.microsoft.com/v2/" },
        { id: "owa", url: "https://outlook.office.com/mail/inbox" },
      ]

      const { byTab, byGroup } = aggregateUnread(
        notifications,
        tabs,
        [],
        {},
        {},
        {
          mutes: [],
          master: false,
        },
      )

      expect(byTab.teams).toBe(0)
      expect(byTab.owa).toBe(0)
      expect(Object.keys(byGroup)).toHaveLength(0)
    })

    it("excludes a muted Slack workspace's notifications from the badge count", () => {
      // A swept Slack entry always carries adapter:'slack' + the merged groupKey
      // (core/slack-sweep-runner.js). The tab maps to the same group via teamGroupMap
      // (T1 → E1), so byTab would be 1 if unmuted — proving the 0 below is the mute, not
      // a team-key mismatch.
      const notifications = [
        notif({
          adapter: "slack",
          groupKey: "slack:E1",
          targetUrl: "https://app.slack.com/client/T1/C1",
        }),
      ]
      const tabs = [{ id: "w1", url: "https://app.slack.com/client/T1/C9" }]
      const teamGroupMap = { T1: "E1" }

      // Control: unmuted, the workspace tab badges 1.
      const unmuted = aggregateUnread(notifications, tabs, [], {}, teamGroupMap, {
        mutes: [],
        master: true,
      })
      expect(unmuted.byTab.w1).toBe(1)
      expect(unmuted.byGroup["slack:E1"]).toBe(1)

      // Muted: the notification is dropped from byGroup, so the tab badge is 0.
      const muted = aggregateUnread(notifications, tabs, [], {}, teamGroupMap, {
        mutes: ["slack:E1"],
        master: true,
      })
      expect(muted.byTab.w1).toBe(0)
      expect(muted.byGroup["slack:E1"]).toBeUndefined()
    })
  })
})
