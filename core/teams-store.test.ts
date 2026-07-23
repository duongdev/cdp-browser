import Database from "better-sqlite3"
import { beforeEach, describe, expect, it } from "vitest"
// SQLite chat store (t127, ADR-0019). Exercised against an in-memory handle — no fs, no server.
import {
  conversationKind,
  getAllPrefs,
  getPrefs,
  getReadState,
  getUsers,
  isMutedNow,
  isReservedConversation,
  listConversations,
  listMessages,
  markConversationRead,
  markConversationUnread,
  migrate,
  parseConsumptionHorizonTs,
  setLocalRead,
  setPrefs,
  setReadHorizon,
  shapeConversation,
  upsertAccount,
  upsertConversations,
  upsertMessages,
  upsertUsers,
} from "./teams-store"

const TENANT = "TENANT-1"

// A raw-ish Teams conversation object (only the fields the store reads).
const conv = (over = {}) => ({
  id: "19:aaa@thread.v2",
  lastUpdatedMessageId: "1700000000001",
  lastUpdatedMessageVersion: 1700000000001,
  threadProperties: { topic: "Design sync" },
  lastMessage: {
    id: "1700000000001",
    content: "hello team",
    originalarrivaltime: "2024-01-01T00:00:00.000Z",
  },
  ...over,
})

let db: InstanceType<typeof Database>
beforeEach(() => {
  db = new Database(":memory:")
  migrate(db)
})

describe("migrate — idempotent full schema", () => {
  it("creates every table + the FTS index and is safe to run twice", () => {
    migrate(db) // second run must not throw
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table') ORDER BY name")
      .all()
      .map((r: any) => r.name)
    for (const t of [
      "accounts",
      "conversations",
      "messages",
      "read_state",
      "messages_fts",
      "users",
    ]) {
      expect(names).toContain(t)
    }
  })
})

describe("classifiers", () => {
  it("keeps 48:notes (the self chat) but flags the other reserved 48:* threads", () => {
    expect(isReservedConversation("48:notes")).toBe(false)
    expect(isReservedConversation("48:notifications")).toBe(true)
    expect(isReservedConversation("48:mentions")).toBe(true)
    expect(isReservedConversation("19:aaa@thread.v2")).toBe(false)
  })
  it("derives kind from the id shape", () => {
    expect(conversationKind("19:xyz@unq.gbl.spaces")).toBe("oneOnOne")
    expect(conversationKind("19:aaa@thread.v2")).toBe("group")
    expect(conversationKind("48:notes")).toBe("self")
  })
  it("shapes a raw conversation into a row (topic, preview, ts, version)", () => {
    const row = shapeConversation(conv(), TENANT)
    expect(row).toMatchObject({
      id: "19:aaa@thread.v2",
      tenant: TENANT,
      kind: "group",
      topic: "Design sync",
      last_message_version: 1700000000001,
      last_message_preview: "hello team",
    })
    expect(row.last_message_ts).toBe(Date.parse("2024-01-01T00:00:00.000Z"))
  })
})

describe("upsertConversations — insert / version-gated update / no-op", () => {
  it("inserts new conversations and initializes the sync cursors", () => {
    upsertConversations(db, TENANT, [conv()], 5000)
    const row: any = db.prepare("SELECT * FROM conversations WHERE id = ?").get("19:aaa@thread.v2")
    expect(row.last_message_version).toBe(1700000000001)
    expect(row.updated_at).toBe(5000)
    // Both cursors initialize to the last-message ts (the anchor t129+ pages from).
    const ts = Date.parse("2024-01-01T00:00:00.000Z")
    expect(row.newest_synced_ts).toBe(ts)
    expect(row.oldest_synced_ts).toBe(ts)
  })

  it("updates a row when lastUpdatedMessageVersion rises", () => {
    upsertConversations(db, TENANT, [conv()], 1000)
    upsertConversations(
      db,
      TENANT,
      [
        conv({
          lastUpdatedMessageVersion: 1700000000999,
          lastMessage: {
            id: "1700000000999",
            content: "newer message",
            originalarrivaltime: "2024-02-02T00:00:00.000Z",
          },
        }),
      ],
      2000,
    )
    const row: any = db.prepare("SELECT * FROM conversations WHERE id = ?").get("19:aaa@thread.v2")
    expect(row.last_message_version).toBe(1700000000999)
    expect(row.last_message_preview).toBe("newer message")
    expect(row.updated_at).toBe(2000)
    // The sync cursor is NOT clobbered by a metadata update (t129+ owns it).
    expect(row.newest_synced_ts).toBe(Date.parse("2024-01-01T00:00:00.000Z"))
  })

  it("no-ops on an equal (or lower) version — the preview is unchanged", () => {
    upsertConversations(db, TENANT, [conv()], 1000)
    upsertConversations(
      db,
      TENANT,
      [conv({ lastMessage: { id: "x", content: "STALE-should-not-write" } })],
      2000,
    )
    const row: any = db.prepare("SELECT * FROM conversations WHERE id = ?").get("19:aaa@thread.v2")
    expect(row.last_message_preview).toBe("hello team")
    expect(row.updated_at).toBe(1000) // untouched
  })

  it("keeps 48:notes (self chat) but skips other reserved 48:* conversations", () => {
    upsertConversations(db, TENANT, [
      conv(),
      {
        id: "48:notes",
        lastUpdatedMessageVersion: 9,
        lastMessage: { content: "self", originalarrivaltime: "2024-05-01T00:00:00.000Z" },
      },
      { id: "48:notifications", lastUpdatedMessageVersion: 9 },
    ])
    const list = listConversations(db, TENANT)
    const ids = list.map((c) => c.id)
    expect(ids).toContain("48:notes")
    expect(ids).not.toContain("48:notifications")
    expect(list.find((c) => c.id === "48:notes")?.kind).toBe("self")
    expect(list.find((c) => c.id === "48:notes")?.topic).toBeNull()
  })

  it("returns the tenant list newest-first via listConversations", () => {
    upsertConversations(db, TENANT, [
      conv({
        id: "19:old@thread.v2",
        lastMessage: { originalarrivaltime: "2020-01-01T00:00:00Z" },
      }),
      conv({
        id: "19:new@thread.v2",
        lastMessage: { originalarrivaltime: "2025-01-01T00:00:00Z" },
      }),
    ])
    expect(listConversations(db, TENANT).map((c) => c.id)).toEqual([
      "19:new@thread.v2",
      "19:old@thread.v2",
    ])
  })
})

// A ReaderMessage-shaped row (what upsertMessages persists), tsMs timestamps.
const rmsg = (over = {}) => ({
  id: "m1",
  ts: Date.parse("2024-03-01T00:00:00.000Z"),
  senderId: "8:orgid:AAA",
  senderName: "Bob",
  body: "hello",
  self: false,
  edited: false,
  deleted: false,
  ...over,
})

describe("upsertMessages / listMessages", () => {
  const CONV = "19:aaa@thread.v2"
  beforeEach(() => {
    // Seed the conversation so cursor advance has a row (cursors start at the last-message ts).
    upsertConversations(db, TENANT, [conv({ id: CONV })])
  })

  it("inserts messages and reads them back newest-first", () => {
    upsertMessages(db, TENANT, CONV, [
      rmsg({ id: "a", ts: 1000, body: "first" }),
      rmsg({ id: "b", ts: 3000, body: "third" }),
      rmsg({ id: "c", ts: 2000, body: "second" }),
    ])
    const out = listMessages(db, TENANT, CONV)
    expect(out.map((m) => m.id)).toEqual(["b", "c", "a"])
    expect(out[0]).toMatchObject({ id: "b", senderName: "Bob", body: "third", edited: false })
  })

  it("replaces a message by (conv_id, id)", () => {
    upsertMessages(db, TENANT, CONV, [rmsg({ id: "a", body: "v1" })])
    upsertMessages(db, TENANT, CONV, [rmsg({ id: "a", body: "v2 edited", edited: true })])
    const out = listMessages(db, TENANT, CONV)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ body: "v2 edited", edited: true })
  })

  it("persists deleted flag as a tombstone body", () => {
    upsertMessages(db, TENANT, CONV, [rmsg({ id: "d", body: "message deleted", deleted: true })])
    const out = listMessages(db, TENANT, CONV)
    expect(out[0]).toMatchObject({ deleted: true, body: "message deleted" })
  })

  it("pages older via the before cursor", () => {
    upsertMessages(db, TENANT, CONV, [
      rmsg({ id: "a", ts: 1000 }),
      rmsg({ id: "b", ts: 2000 }),
      rmsg({ id: "c", ts: 3000 }),
    ])
    const older = listMessages(db, TENANT, CONV, { before: 3000, limit: 30 })
    expect(older.map((m) => m.id)).toEqual(["b", "a"])
  })

  it("honors the limit", () => {
    upsertMessages(
      db,
      TENANT,
      CONV,
      Array.from({ length: 5 }, (_, i) => rmsg({ id: `m${i}`, ts: 1000 + i })),
    )
    expect(listMessages(db, TENANT, CONV, { limit: 2 })).toHaveLength(2)
  })

  it("advances oldest_synced_ts down and newest_synced_ts up", () => {
    // Seeded cursors both equal the conversation's last-message ts.
    const seedRow: any = db.prepare("SELECT * FROM conversations WHERE id = ?").get(CONV)
    upsertMessages(db, TENANT, CONV, [rmsg({ id: "old", ts: 1 }), rmsg({ id: "new", ts: 9e14 })])
    const row: any = db.prepare("SELECT * FROM conversations WHERE id = ?").get(CONV)
    expect(row.oldest_synced_ts).toBe(1)
    expect(row.newest_synced_ts).toBe(9e14)
    expect(row.newest_synced_ts).toBeGreaterThan(seedRow.newest_synced_ts)
  })

  it("scopes reads by tenant", () => {
    upsertMessages(db, TENANT, CONV, [rmsg({ id: "a" })])
    expect(listMessages(db, "OTHER", CONV)).toEqual([])
  })
})

describe("upsertAccount", () => {
  it("inserts then updates the single signed-in identity", () => {
    upsertAccount(db, { tenant: TENANT, userId: "U1", chatServiceBase: "https://apac.ng.msg" }, 1)
    upsertAccount(db, { tenant: TENANT, userId: "U1", chatServiceBase: "https://euno.ng.msg" }, 2)
    const row: any = db.prepare("SELECT * FROM accounts WHERE tenant = ?").get(TENANT)
    expect(row).toMatchObject({
      user_id: "U1",
      chat_service_base: "https://euno.ng.msg",
      updated_at: 2,
    })
    expect(db.prepare("SELECT COUNT(*) n FROM accounts").get()).toMatchObject({ n: 1 })
  })
})

describe("users — display-name cache (t131)", () => {
  it("upserts names and reads back a mri→name map for the requested mris", () => {
    upsertUsers(db, [
      { mri: "8:orgid:AAA", displayName: "Alice" },
      { mri: "8:orgid:BBB", displayName: "Bob" },
    ])
    const map = getUsers(db, ["8:orgid:AAA", "8:orgid:BBB", "8:orgid:CCC"])
    expect(map.get("8:orgid:AAA")).toBe("Alice")
    expect(map.get("8:orgid:BBB")).toBe("Bob")
    expect(map.has("8:orgid:CCC")).toBe(false) // uncached miss — the caller resolves it
  })

  it("updates a name in place (a person can be renamed)", () => {
    upsertUsers(db, [{ mri: "8:orgid:AAA", displayName: "Alice" }])
    upsertUsers(db, [{ mri: "8:orgid:AAA", displayName: "Alice Smith" }])
    expect(getUsers(db, ["8:orgid:AAA"]).get("8:orgid:AAA")).toBe("Alice Smith")
  })

  it("skips rows without a mri or a name, and no-ops on empty input", () => {
    upsertUsers(db, [
      { mri: "8:orgid:AAA", displayName: "Alice" },
      { mri: "", displayName: "Nameless" },
      { mri: "8:orgid:BBB", displayName: "" },
    ])
    upsertUsers(db, [])
    const map = getUsers(db, ["8:orgid:AAA", "8:orgid:BBB"])
    expect(map.get("8:orgid:AAA")).toBe("Alice")
    expect(map.has("8:orgid:BBB")).toBe(false)
  })

  it("returns an empty map for an empty mri list", () => {
    upsertUsers(db, [{ mri: "8:orgid:AAA", displayName: "Alice" }])
    expect(getUsers(db, []).size).toBe(0)
  })
})

describe("read_state — local read on open, write-through horizon on reply (t130)", () => {
  const CONV = "19:conv@unq.gbl.spaces"

  it("no row until a read is recorded", () => {
    expect(getReadState(db, CONV)).toBeNull()
  })

  it("setLocalRead and setReadHorizon write independent columns without clobbering", () => {
    setLocalRead(db, TENANT, CONV, 100)
    expect(getReadState(db, CONV)).toEqual({
      tenant: TENANT,
      localReadTs: 100,
      readHorizonTs: null,
    })
    setReadHorizon(db, TENANT, CONV, 200)
    expect(getReadState(db, CONV)).toEqual({
      tenant: TENANT,
      localReadTs: 100,
      readHorizonTs: 200,
    })
  })

  it("both are monotonic — an older ts never rewinds the stored value", () => {
    setReadHorizon(db, TENANT, CONV, 500)
    setReadHorizon(db, TENANT, CONV, 300)
    setLocalRead(db, TENANT, CONV, 500)
    setLocalRead(db, TENANT, CONV, 300)
    expect(getReadState(db, CONV)).toEqual({
      tenant: TENANT,
      localReadTs: 500,
      readHorizonTs: 500,
    })
  })
})

describe("unread derivation over read_state (t155)", () => {
  const CONV = "19:aaa@thread.v2"
  const at = (isoTs: number) => new Date(isoTs).toISOString()
  const row = () => {
    const r = listConversations(db, TENANT).find((c) => c.id === CONV)
    if (!r) throw new Error("conversation not found")
    return r
  }

  it("parseConsumptionHorizonTs pulls the middle ts, null on garbage", () => {
    expect(parseConsumptionHorizonTs("111;1784785213736;999")).toBe(1784785213736)
    expect(parseConsumptionHorizonTs("")).toBeNull()
    expect(parseConsumptionHorizonTs(undefined)).toBeNull()
    expect(parseConsumptionHorizonTs("only-one-part")).toBeNull()
  })

  it("ingests properties.consumptionhorizon into read_horizon_ts + exposes readTs", () => {
    upsertConversations(db, TENANT, [
      conv({ lastMessage: { id: "m1", content: "hi", originalarrivaltime: at(1000) } }),
    ])
    expect(row().readTs).toBe(0) // no horizon on this conv fixture
    upsertConversations(db, TENANT, [
      conv({
        lastUpdatedMessageVersion: 1700000000002,
        lastMessage: { id: "m2", content: "hi", originalarrivaltime: at(2000) },
        properties: { consumptionhorizon: "m2;1500;9" },
      }),
    ])
    expect(row().readTs).toBe(1500)
  })

  it("flags last_message_from_me from the last message sender vs selfId", () => {
    upsertConversations(
      db,
      TENANT,
      [
        conv({
          lastMessage: {
            id: "m1",
            content: "hi",
            originalarrivaltime: at(1000),
            from: "8:orgid:me-oid",
          },
        }),
      ],
      Date.now(),
      "me-oid",
    )
    expect(row().lastMessageFromMe).toBe(true)
  })

  it("mark-read forces readTs to the last ts; open (setLocalRead) also clears", () => {
    upsertConversations(db, TENANT, [
      conv({ lastMessage: { id: "m1", content: "hi", originalarrivaltime: at(5000) } }),
    ])
    markConversationRead(db, TENANT, CONV, 5000)
    expect(row().readTs).toBe(5000)
    expect(row().unreadSticky).toBe(false)
  })

  it("mark-unread sets a sticky sentinel that survives an advancing Teams horizon", () => {
    upsertConversations(db, TENANT, [
      conv({ lastMessage: { id: "m1", content: "hi", originalarrivaltime: at(5000) } }),
    ])
    markConversationUnread(db, TENANT, CONV)
    expect(row().unreadSticky).toBe(true)
    expect(row().readTs).toBe(0)
    // A poll ingests a fresh Teams horizon past the last message — the sentinel still wins.
    setReadHorizon(db, TENANT, CONV, 9000)
    expect(row().unreadSticky).toBe(true)
    expect(row().readTs).toBe(0)
    // Opening the thread (setLocalRead) overwrites the sentinel → read again.
    setLocalRead(db, TENANT, CONV, 5000)
    expect(row().unreadSticky).toBe(false)
    expect(row().readTs).toBe(9000)
  })
})

describe("conversation prefs (t156)", () => {
  let db: InstanceType<typeof Database>
  beforeEach(() => {
    db = new Database(":memory:")
    migrate(db)
  })

  // The empty/default extras added by t167/t168 (timed mute, mention override, rename).
  const EXTRAS = { mutedUntil: null, notifyOnMention: false, customTitle: null }

  it("defaults to empty when no row exists", () => {
    expect(getPrefs(db, "19:x@thread.v2")).toEqual({
      labels: [],
      folder: null,
      muted: false,
      ...EXTRAS,
    })
    expect(getAllPrefs(db)).toEqual({})
  })

  it("setPrefs upserts and patches only provided keys", () => {
    setPrefs(db, "c1", { folder: "Work", labels: ["urgent", "team"] })
    expect(getPrefs(db, "c1")).toEqual({
      folder: "Work",
      labels: ["urgent", "team"],
      muted: false,
      ...EXTRAS,
    })
    // A partial patch keeps the untouched keys.
    setPrefs(db, "c1", { muted: true })
    expect(getPrefs(db, "c1")).toEqual({
      folder: "Work",
      labels: ["urgent", "team"],
      muted: true,
      ...EXTRAS,
    })
  })

  it("sanitizes labels: trim, drop empty, dedupe", () => {
    setPrefs(db, "c1", { labels: [" a ", "a", "", "b"] })
    expect(getPrefs(db, "c1").labels).toEqual(["a", "b"])
  })

  it("empty folder string un-files (folder → null)", () => {
    setPrefs(db, "c1", { folder: "Work" })
    setPrefs(db, "c1", { folder: "" })
    expect(getPrefs(db, "c1").folder).toBe(null)
  })

  it("getAllPrefs returns every stored conversation's prefs", () => {
    setPrefs(db, "c1", { folder: "Work" })
    setPrefs(db, "c2", { muted: true })
    expect(getAllPrefs(db)).toEqual({
      c1: { labels: [], folder: "Work", muted: false, ...EXTRAS },
      c2: { labels: [], folder: null, muted: true, ...EXTRAS },
    })
  })

  it("survives a re-migrate (idempotent, prefs kept)", () => {
    setPrefs(db, "c1", { folder: "Work", labels: ["x"], muted: true })
    migrate(db)
    expect(getPrefs(db, "c1")).toEqual({
      folder: "Work",
      labels: ["x"],
      muted: true,
      ...EXTRAS,
    })
  })

  it("timed mute + notify-on-mention + rename round-trip (t167/t168)", () => {
    setPrefs(db, "c1", { muted: true, mutedUntil: 5000, notifyOnMention: true })
    expect(getPrefs(db, "c1")).toMatchObject({
      muted: true,
      mutedUntil: 5000,
      notifyOnMention: true,
    })
    expect(isMutedNow(getPrefs(db, "c1"), 1000)).toBe(true)
    expect(isMutedNow(getPrefs(db, "c1"), 9000)).toBe(false) // expired window
    // A muted write WITHOUT an expiry clears the stale window (mute forever).
    setPrefs(db, "c1", { muted: true })
    expect(getPrefs(db, "c1").mutedUntil).toBe(null)
    // Rename; blank clears.
    setPrefs(db, "c1", { customTitle: "  Boss  " })
    expect(getPrefs(db, "c1").customTitle).toBe("Boss")
    setPrefs(db, "c1", { customTitle: "" })
    expect(getPrefs(db, "c1").customTitle).toBe(null)
  })
})
