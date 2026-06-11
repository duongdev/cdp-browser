import { describe, expect, it, vi } from "vitest"
// Effectful sweep orchestrator (t071) — composes slack-api + slack-sweep behind injected
// effects. Tested with a fake API so no network/CDP is needed.
import { createSlackSweeper, normalizeUsersCounts } from "./slack-sweep-runner"

// A fake Slack API whose responses a test scripts per method.
function fakeApi(resp: Record<string, unknown>) {
  return {
    clientCounts: vi.fn(
      async () => resp.clientCounts ?? { ok: true, channels: [], ims: [], mpims: [] },
    ),
    usersCounts: vi.fn(async () => resp.usersCounts ?? { ok: true, channels: [], ims: [] }),
    conversationsHistory: vi.fn(async (channel: string) => {
      const h = (resp.history as Record<string, unknown>) || {}
      return h[channel] ?? { ok: true, messages: [] }
    }),
    usersPrefsGet: vi.fn(async () => resp.prefs ?? { ok: true, prefs: { muted_channels: "" } }),
    authTest: vi.fn(async () => resp.auth ?? { ok: true, user_id: "U_SELF" }),
    usersInfo: vi.fn(async (user: string) => ({
      ok: true,
      user: { name: user, profile: { display_name: `name-${user}` } },
    })),
    conversationsInfo: vi.fn(async (channel: string) => ({
      ok: true,
      channel: { id: channel, name: `chan-${channel}` },
    })),
  }
}

function harness(api: ReturnType<typeof fakeApi>) {
  const watermarks: Record<string, Record<string, string>> = {}
  const seeded = new Set<string>()
  const muted: Record<string, string[]> = {}
  const selfIds: Record<string, string> = {}
  const ingested: any[] = []
  const reads: Array<{ team: string; lastRead: Record<string, string> }> = []
  const readByUnread: Array<{ team: string; unread: string[] }> = []
  const stale: string[] = []
  const unsweepable: Array<{ team: string; reason: string }> = []
  const sweeper = createSlackSweeper({
    makeApi: () => api,
    markUnsweepable: (t: string, reason: string) => unsweepable.push({ team: t, reason }),
    getWatermark: (t: string) => watermarks[t] || {},
    setWatermark: (t: string, w: Record<string, string>) => {
      watermarks[t] = w
    },
    isSeeded: (t: string) => seeded.has(t),
    markSeeded: (t: string) => seeded.add(t),
    getExcludes: () => [],
    getMuted: (t: string) => muted[t],
    setMuted: (t: string, m: string[]) => {
      muted[t] = m
    },
    getSelfUserId: (t: string) => selfIds[t],
    setSelfUserId: (t: string, u: string) => {
      selfIds[t] = u
    },
    ingestEntry: (e: any) => ingested.push(e),
    applyReadUpdates: (team: string, lastRead: Record<string, string>) =>
      reads.push({ team, lastRead }),
    applyReadByUnread: (team: string, unreadSet: Set<string>) =>
      readByUnread.push({ team, unread: [...unreadSet].sort() }),
    markStale: (t: string) => stale.push(t),
    now: () => 1_700_000_000_000,
    log: () => {},
  })
  return { sweeper, ingested, reads, readByUnread, stale, unsweepable, watermarks, seeded }
}

const cred = {
  teamId: "T1",
  token: "xoxc-1",
  cookie: "xoxd-1",
  name: "Acme",
  url: "https://acme.slack.com/",
}

describe("first sweep seeds the watermark and emits nothing (no cold-start spam)", () => {
  it("baselines watermarks from counts.latest and does not notify existing unreads", async () => {
    const api = fakeApi({
      clientCounts: {
        ok: true,
        channels: [],
        ims: [{ id: "D1", last_read: "100.0", latest: "150.0", has_unreads: true }],
        mpims: [],
      },
      history: {
        D1: {
          ok: true,
          messages: [{ type: "message", user: "U2", ts: "150.0", text: "old unread" }],
        },
      },
    })
    const h = harness(api)
    await h.sweeper.sweepWorkspace(cred)
    expect(h.ingested).toHaveLength(0) // seeded, not notified
    expect(h.watermarks.T1.D1).toBe("150.0") // baselined to latest
    expect(h.seeded.has("T1")).toBe(true)
  })
})

describe("subsequent sweep notifies new messages", () => {
  it("emits an entry for a message newer than the seeded watermark", async () => {
    const api = fakeApi({
      clientCounts: {
        ok: true,
        channels: [],
        ims: [{ id: "D1", last_read: "150.0", latest: "160.0", has_unreads: true }],
        mpims: [],
      },
      history: {
        D1: { ok: true, messages: [{ type: "message", user: "U2", ts: "160.0", text: "new dm" }] },
      },
    })
    const h = harness(api)
    // pretend already seeded with D1 @ 150
    h.watermarks.T1 = { D1: "150.0" }
    h.seeded.add("T1")
    await h.sweeper.sweepWorkspace(cred)
    expect(h.ingested).toHaveLength(1)
    expect(h.ingested[0].id).toBe("slack:T1:D1:160.0")
    expect(h.ingested[0].channelId).toBe("D1")
    expect(h.watermarks.T1.D1).toBe("160.0")
    // Rendered (t073): DM title is just the sender's display name; body is the message.
    expect(h.ingested[0].title).toBe("name-U2")
    expect(h.ingested[0].body).toBe("new dm")
  })
})

describe("read sync + auth + invalid_auth", () => {
  it("applies read updates from counts last_read", async () => {
    const api = fakeApi({
      clientCounts: {
        ok: true,
        channels: [],
        ims: [{ id: "D1", last_read: "200.0", latest: "200.0", has_unreads: false }],
        mpims: [],
      },
    })
    const h = harness(api)
    h.seeded.add("T1")
    await h.sweeper.sweepWorkspace(cred)
    expect(h.reads).toEqual([{ team: "T1", lastRead: { D1: "200.0" } }])
  })

  it("marks creds stale on invalid_auth and does nothing else", async () => {
    const api = fakeApi({ clientCounts: { error: "invalid_auth" } })
    const h = harness(api)
    await h.sweeper.sweepWorkspace(cred)
    expect(h.stale).toEqual(["T1"])
    expect(h.ingested).toHaveLength(0)
  })

  it("does NOT mark unsweepable on team_is_restricted when users.counts works (t075 fallback)", async () => {
    // client.counts restricted but users.counts ok (default fake) → falls back, seeds, covered.
    const api = fakeApi({ clientCounts: { error: "team_is_restricted" } })
    const h = harness(api)
    await h.sweeper.sweepWorkspace(cred)
    expect(h.unsweepable).toEqual([]) // covered via the fallback, not abandoned
    expect(h.stale).toEqual([])
    expect(h.seeded.has("T1")).toBe(true)
  })

  it("resolves self user id once (auth.test) for mention parity", async () => {
    const api = fakeApi({
      auth: { ok: true, user_id: "U_ME" },
      clientCounts: {
        ok: true,
        channels: [
          { id: "C1", last_read: "100.0", latest: "160.0", mention_count: 1, has_unreads: true },
        ],
        ims: [],
        mpims: [],
      },
      history: {
        C1: {
          ok: true,
          messages: [
            { type: "message", user: "U2", ts: "160.0", text: "ping <@U_ME>" },
            { type: "message", user: "U2", ts: "161.0", text: "no mention" },
          ],
        },
      },
    })
    const h = harness(api)
    h.seeded.add("T1")
    h.watermarks.T1 = { C1: "100.0" }
    await h.sweeper.sweepWorkspace(cred)
    expect(api.authTest).toHaveBeenCalledTimes(1)
    // only the mention notifies (channel parity); id retains the Slack ts
    expect(h.ingested.map((e) => e.id)).toEqual(["slack:T1:C1:160.0"])
  })
})

describe("muted channels honored", () => {
  it("does not notify a muted channel even with a mention", async () => {
    const api = fakeApi({
      prefs: { ok: true, prefs: { muted_channels: "C1,C2" } },
      clientCounts: {
        ok: true,
        channels: [
          { id: "C1", last_read: "100.0", latest: "160.0", mention_count: 1, has_unreads: true },
        ],
        ims: [],
        mpims: [],
      },
      history: {
        C1: {
          ok: true,
          messages: [{ type: "message", user: "U2", ts: "160.0", text: "<@U_SELF> hi" }],
        },
      },
    })
    const h = harness(api)
    h.seeded.add("T1")
    await h.sweeper.sweepWorkspace(cred)
    expect(h.ingested).toHaveLength(0)
  })
})

describe("runOnce sweeps all fresh-cred workspaces", () => {
  it("sweeps each workspace returned by listCreds, skipping stale ones", async () => {
    const api = fakeApi({})
    const swept: string[] = []
    const sweeper = createSlackSweeper({
      makeApi: () => api,
      getWatermark: () => ({}),
      setWatermark: () => {},
      isSeeded: () => true,
      markSeeded: () => {},
      getExcludes: () => [],
      getMuted: () => [],
      setMuted: () => {},
      getSelfUserId: () => "U",
      setSelfUserId: () => {},
      ingestEntry: () => {},
      applyReadUpdates: (team: string) => swept.push(team),
      markStale: () => {},
      now: () => 1,
      log: () => {},
      listCreds: () => [
        { teamId: "T1", token: "a", cookie: "c", fresh: true },
        { teamId: "T2", token: "b", cookie: "c", fresh: false }, // stale → skipped
        { teamId: "T3", token: "d", cookie: "c", fresh: true },
      ],
    })
    await sweeper.runOnce()
    expect(swept.sort()).toEqual(["T1", "T3"])
  })
})

describe("normalizeUsersCounts (t075)", () => {
  it("maps channels (mention/unread → has_unreads) and ims (dm_count) into client.counts shape", () => {
    const uc = {
      ok: true,
      channels: [
        { id: "C1", mention_count_display: 2, unread_count_display: 5, is_muted: false },
        { id: "C2", mention_count_display: 0, unread_count_display: 3, is_muted: true },
        { id: "C3", mention_count_display: 0, unread_count_display: 0 },
      ],
      ims: [
        { id: "D1", dm_count: 1 },
        { id: "D2", dm_count: 0 },
      ],
    }
    const norm = normalizeUsersCounts(uc)
    expect(norm.channels).toEqual([
      { id: "C1", mention_count: 2, has_unreads: true, last_read: "0" },
      { id: "C2", mention_count: 0, has_unreads: true, last_read: "0" },
      { id: "C3", mention_count: 0, has_unreads: false, last_read: "0" },
    ])
    expect(norm.ims).toEqual([
      { id: "D1", mention_count: 0, has_unreads: true, last_read: "0" },
      { id: "D2", mention_count: 0, has_unreads: false, last_read: "0" },
    ])
    expect(norm.muted).toEqual(["C2"])
  })
})

describe("restricted workspace falls back to users.counts (t075)", () => {
  const restrictedApi = (over = {}) =>
    fakeApi({
      clientCounts: { error: "team_is_restricted" },
      usersCounts: {
        ok: true,
        channels: [{ id: "C1", mention_count_display: 1, unread_count_display: 1 }],
        ims: [{ id: "D1", dm_count: 1 }],
      },
      ...over,
    })

  it("first sweep seeds to now (no latest needed) and notifies nothing", async () => {
    const h = harness(restrictedApi())
    await h.sweeper.sweepWorkspace({ teamId: "T1", token: "t", cookie: "c", name: "Grid" })
    expect(h.ingested).toHaveLength(0)
    expect(h.seeded.has("T1")).toBe(true)
    // every conversation watermarked to the same "now" ts
    expect(h.watermarks.T1.C1).toBe("1700000000.000000")
    expect(h.watermarks.T1.D1).toBe("1700000000.000000")
    // read-sync used the unread-set path, not last_read
    expect(h.readByUnread).toEqual([{ team: "T1", unread: ["C1", "D1"] }])
    expect(h.reads).toHaveLength(0)
  })

  it("notifies a post-seed DM message and is not marked unsweepable", async () => {
    const h = harness(
      restrictedApi({
        history: {
          D1: {
            ok: true,
            messages: [{ type: "message", user: "U2", ts: "1700000050.0", text: "hi" }],
          },
        },
      }),
    )
    h.seeded.add("T1")
    h.watermarks.T1 = { D1: "1700000000.000000", C1: "1700000000.000000" }
    await h.sweeper.sweepWorkspace({ teamId: "T1", token: "t", cookie: "c", name: "Grid" })
    expect(h.unsweepable).toHaveLength(0)
    expect(h.ingested.map((e) => e.id)).toEqual(["slack:T1:D1:1700000050.0"])
  })

  it("marks unsweepable only when users.counts ALSO fails", async () => {
    const h = harness(
      fakeApi({
        clientCounts: { error: "team_is_restricted" },
        usersCounts: { error: "team_is_restricted" },
      }),
    )
    await h.sweeper.sweepWorkspace({ teamId: "T1", token: "t", cookie: "c" })
    expect(h.unsweepable).toEqual([{ team: "T1", reason: "team_is_restricted" }])
  })
})

describe("fetchConversation (t077 reader history)", () => {
  it("returns oldest-first rendered messages with resolved names", async () => {
    const api = fakeApi({
      history: {
        C1: {
          ok: true,
          messages: [
            { ts: "2.0", user: "U_B", text: "later <@U_A>" },
            { ts: "1.0", user: "U_A", text: "first" },
          ],
        },
      },
    })
    const { sweeper } = harness(api)
    const out: any = await sweeper.fetchConversation(cred, "C1")
    expect(out.error).toBeUndefined()
    expect(out.messages.map((m: any) => m.ts)).toEqual(["1.0", "2.0"])
    expect(out.messages[0].senderName).toBe("name-U_A")
    expect(out.messages[1].body).toBe("later @name-U_A")
  })

  it("surfaces a typed auth error and marks creds stale", async () => {
    const api = fakeApi({})
    api.conversationsHistory = vi.fn(async () => ({ error: "invalid_auth" }))
    const { sweeper, stale } = harness(api)
    const out: any = await sweeper.fetchConversation(cred, "C1")
    expect(out.error).toBe("invalid_auth")
    expect(stale).toEqual(["T1"])
  })

  it("surfaces rate limiting as a typed error", async () => {
    const api = fakeApi({})
    api.conversationsHistory = vi.fn(async () => ({ error: "rate_limited" }))
    const { sweeper } = harness(api)
    const out: any = await sweeper.fetchConversation(cred, "C1")
    expect(out.error).toBe("rate_limited")
  })
})

describe("entries carry thread identity (t078)", () => {
  it("stamps slackThreadTs on ingested entries", async () => {
    const api = fakeApi({
      clientCounts: {
        ok: true,
        channels: [],
        mpims: [],
        ims: [{ id: "D1", has_unreads: true, mention_count: 1, last_read: "0", latest: "9.0" }],
      },
      history: {
        D1: {
          ok: true,
          messages: [{ ts: "9.0", user: "U_A", text: "in thread", thread_ts: "8.0" }],
        },
      },
    })
    const { sweeper, ingested, seeded } = harness(api)
    seeded.add("T1")
    await sweeper.sweepWorkspace(cred)
    expect(ingested).toHaveLength(1)
    expect(ingested[0].slackThreadTs).toBe("8.0")
  })
})
