import { describe, expect, it } from "vitest"
// Pure watermark/parity reducer for the Slack content sweep (t068, ADR-0011).
import { applyReadUpdates, isMention, planFetches, reduceMessages, tsCmp } from "./slack-sweep"

describe("tsCmp — Slack ts ordering (string-exact, no float loss)", () => {
  it("orders by integer then fractional part", () => {
    expect(tsCmp("1678243870.246189", "1678243870.246190")).toBeLessThan(0)
    expect(tsCmp("1678243871.000000", "1678243870.999999")).toBeGreaterThan(0)
    expect(tsCmp("100.5", "100.5")).toBe(0)
  })
  it("handles missing fractional parts", () => {
    expect(tsCmp("100", "100.000001")).toBeLessThan(0)
    expect(tsCmp("0", "1.0")).toBeLessThan(0)
  })
})

describe("isMention — channel parity (only @-mentions notify)", () => {
  const self = "U_ME"
  const subteams = ["S_TEAM1"]
  it("matches a direct mention of self", () => {
    expect(isMention("hey <@U_ME> look", self, subteams)).toBe(true)
  })
  it("does not match a mention of someone else", () => {
    expect(isMention("hey <@U_OTHER> look", self, subteams)).toBe(false)
  })
  it("matches @here/@channel/@everyone broadcasts", () => {
    expect(isMention("<!here> standup", self, subteams)).toBe(true)
    expect(isMention("<!channel> ping", self, subteams)).toBe(true)
    expect(isMention("<!everyone> hi", self, subteams)).toBe(true)
  })
  it("matches a subteam (user-group) the self belongs to", () => {
    expect(isMention("<!subteam^S_TEAM1|@frontend> deploy", self, subteams)).toBe(true)
    expect(isMention("<!subteam^S_OTHER|@backend> deploy", self, subteams)).toBe(false)
  })
  it("returns false for plain text", () => {
    expect(isMention("just a normal message", self, subteams)).toBe(false)
  })
})

const counts = (over = {}) => ({
  ok: true,
  channels: [
    { id: "C_MENTION", last_read: "100.0", latest: "150.0", mention_count: 1, has_unreads: true },
    { id: "C_NOMENTION", last_read: "100.0", latest: "150.0", mention_count: 0, has_unreads: true },
    { id: "C_MUTED", last_read: "100.0", latest: "150.0", mention_count: 2, has_unreads: true },
  ],
  ims: [{ id: "D_DM", last_read: "100.0", latest: "160.0", mention_count: 0, has_unreads: true }],
  mpims: [
    { id: "G_GROUP", last_read: "100.0", latest: "170.0", mention_count: 0, has_unreads: true },
  ],
  threads: { has_unreads: false, mention_count: 0 },
  ...over,
})

describe("planFetches — which conversations to fetch", () => {
  it("includes unread DMs and group DMs always", () => {
    const plans = planFetches(counts(), { watermark: {}, excludes: [], muted: [] })
    const ids = plans.map((p) => p.id)
    expect(ids).toContain("D_DM")
    expect(ids).toContain("G_GROUP")
  })
  it("includes channels only when there's a mention", () => {
    const plans = planFetches(counts(), { watermark: {}, excludes: [], muted: [] })
    const ids = plans.map((p) => p.id)
    expect(ids).toContain("C_MENTION")
    expect(ids).not.toContain("C_NOMENTION")
  })
  it("skips muted channels even with a mention", () => {
    const plans = planFetches(counts(), { watermark: {}, excludes: [], muted: ["C_MUTED"] })
    expect(plans.map((p) => p.id)).not.toContain("C_MUTED")
  })
  it("skips excluded conversations (channel or DM)", () => {
    const plans = planFetches(counts(), {
      watermark: {},
      excludes: ["D_DM", "C_MENTION"],
      muted: [],
    })
    const ids = plans.map((p) => p.id)
    expect(ids).not.toContain("D_DM")
    expect(ids).not.toContain("C_MENTION")
  })
  it("uses the watermark as oldest when ahead of last_read", () => {
    const plans = planFetches(counts(), { watermark: { D_DM: "155.0" }, excludes: [], muted: [] })
    const dm = plans.find((p) => p.id === "D_DM")
    expect(dm?.oldest).toBe("155.0")
  })
  it("uses last_read as oldest when no watermark yet", () => {
    const plans = planFetches(counts(), { watermark: {}, excludes: [], muted: [] })
    const dm = plans.find((p) => p.id === "D_DM")
    expect(dm?.oldest).toBe("100.0")
  })
})

const self = { selfUserId: "U_ME", selfSubteamIds: [] as string[] }
const msg = (over = {}) => ({
  channelId: "D_DM",
  kind: "im",
  ts: "150.0",
  user: "U_OTHER",
  text: "hello",
  ...over,
})

describe("reduceMessages — entry synthesis + parity", () => {
  it("synthesizes a DM message into an entry with a stable id", () => {
    const { newEntries } = reduceMessages({
      team: "T1",
      candidates: [msg()],
      watermark: {},
      excludes: [],
      muted: [],
      ...self,
    })
    expect(newEntries).toHaveLength(1)
    expect(newEntries[0].id).toBe("slack:T1:D_DM:150.0")
    expect(newEntries[0].groupKey).toBe("slack:T1")
  })

  it("drops a channel message with no mention, keeps a channel mention", () => {
    const { newEntries } = reduceMessages({
      team: "T1",
      candidates: [
        { channelId: "C1", kind: "channel", ts: "150.0", user: "U_OTHER", text: "no ping here" },
        { channelId: "C1", kind: "channel", ts: "151.0", user: "U_OTHER", text: "hey <@U_ME>" },
      ],
      watermark: {},
      excludes: [],
      muted: [],
      ...self,
    })
    expect(newEntries.map((e) => e.ts)).toEqual(["151.0"])
  })

  it("skips system-subtype messages (joins, retention notices)", () => {
    const { newEntries } = reduceMessages({
      team: "T1",
      candidates: [
        {
          channelId: "D_DM",
          kind: "im",
          ts: "150.0",
          user: "U2",
          subtype: "channel_join",
          text: "joined",
        },
        {
          channelId: "D_DM",
          kind: "im",
          ts: "151.0",
          user: "USLACKBOT",
          subtype: "retention_threshold",
          text: "old msgs gone",
        },
      ],
      watermark: {},
      excludes: [],
      muted: [],
      ...self,
    })
    expect(newEntries).toHaveLength(0)
  })

  it("skips messages at or below the watermark (no dupes on re-run)", () => {
    const { newEntries } = reduceMessages({
      team: "T1",
      candidates: [msg({ ts: "150.0" }), msg({ ts: "151.0" })],
      watermark: { D_DM: "150.0" },
      excludes: [],
      muted: [],
      ...self,
    })
    expect(newEntries.map((e) => e.ts)).toEqual(["151.0"])
  })

  it("advances nextWatermark to the newest ts per channel", () => {
    const { nextWatermark } = reduceMessages({
      team: "T1",
      candidates: [msg({ ts: "150.0" }), msg({ ts: "152.0" }), msg({ ts: "151.0" })],
      watermark: {},
      excludes: [],
      muted: [],
      ...self,
    })
    expect(nextWatermark.D_DM).toBe("152.0")
  })

  it("excludes and mutes drop candidates entirely", () => {
    const { newEntries } = reduceMessages({
      team: "T1",
      candidates: [
        msg({ channelId: "D_DM", ts: "150.0" }),
        { channelId: "C_MUTED", kind: "channel", ts: "150.0", user: "U2", text: "<@U_ME> hi" },
      ],
      watermark: {},
      excludes: ["D_DM"],
      muted: ["C_MUTED"],
      ...self,
    })
    expect(newEntries).toHaveLength(0)
  })

  it("treats group DMs (mpim) and threads as always-notify like DMs", () => {
    const { newEntries } = reduceMessages({
      team: "T1",
      candidates: [
        { channelId: "G1", kind: "mpim", ts: "150.0", user: "U2", text: "group msg" },
        {
          channelId: "C9",
          kind: "thread",
          ts: "151.0",
          user: "U2",
          text: "thread reply, no mention",
        },
      ],
      watermark: {},
      excludes: [],
      muted: [],
      ...self,
    })
    expect(newEntries.map((e) => e.channelId).sort()).toEqual(["C9", "G1"])
  })

  // Enterprise Grid (t092): a distinct groupId keys the id + groupKey by the merged group,
  // while the concrete `team` is preserved on the entry for deep-link/activation. This is the
  // dedup invariant — an org pseudo-team and its member workspace surface the same (channel,
  // ts) and must collapse to the same id.
  it("keys id + groupKey by groupId when given, keeping the concrete team", () => {
    const { newEntries } = reduceMessages({
      team: "TGFUQ89E1",
      groupId: "E0761H36LHY",
      candidates: [msg({ channelId: "D1", ts: "150.0" })],
      watermark: {},
      excludes: [],
      muted: [],
      ...self,
    })
    expect(newEntries).toHaveLength(1)
    expect(newEntries[0].id).toBe("slack:E0761H36LHY:D1:150.0")
    expect(newEntries[0].groupKey).toBe("slack:E0761H36LHY")
    expect(newEntries[0].team).toBe("TGFUQ89E1")
  })
})

describe("applyReadUpdates — follow Slack last_read", () => {
  const entries = [
    { id: "slack:T1:D_DM:140.0", channelId: "D_DM", ts: "140.0", read: false },
    { id: "slack:T1:D_DM:160.0", channelId: "D_DM", ts: "160.0", read: false },
    { id: "slack:T1:C1:150.0", channelId: "C1", ts: "150.0", read: false },
  ]
  it("marks entries at or below the channel's last_read as read", () => {
    const out = applyReadUpdates(entries, { D_DM: "150.0", C1: "100.0" })
    expect(out.find((e) => e.ts === "140.0")?.read).toBe(true) // <= 150 read
    expect(out.find((e) => e.ts === "160.0")?.read).toBe(false) // > 150 stays unread
    expect(out.find((e) => e.id === "slack:T1:C1:150.0")?.read).toBe(false) // > 100 unread
  })
  it("returns the same reference when nothing changes", () => {
    const out = applyReadUpdates(entries, { D_DM: "0", C1: "0" })
    expect(out).toBe(entries)
  })
  it("ignores channels with no last_read entry", () => {
    const out = applyReadUpdates(entries, {})
    expect(out).toBe(entries)
  })
})

describe("thread_ts passthrough (t078 reply targeting)", () => {
  it("carries a candidate's thread_ts onto the entry", () => {
    const { newEntries } = reduceMessages({
      team: "T1",
      candidates: [
        { channelId: "D1", kind: "im", ts: "5.0", user: "U2", text: "hi", thread_ts: "4.0" },
        { channelId: "D1", kind: "im", ts: "6.0", user: "U2", text: "top-level" },
      ],
    })
    expect(newEntries.map((e: any) => e.threadTs)).toEqual(["4.0", null])
  })
})
