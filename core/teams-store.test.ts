import Database from "better-sqlite3"
import { beforeEach, describe, expect, it } from "vitest"
// SQLite chat store (t105, ADR-0018). Exercised against an in-memory handle — no fs, no server.
import {
  conversationKind,
  isReservedConversation,
  listConversations,
  migrate,
  shapeConversation,
  upsertAccount,
  upsertConversations,
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
    for (const t of ["accounts", "conversations", "messages", "read_state", "messages_fts"]) {
      expect(names).toContain(t)
    }
  })
})

describe("classifiers", () => {
  it("flags reserved 48:* (self / notifications / mentions)", () => {
    expect(isReservedConversation("48:notes")).toBe(true)
    expect(isReservedConversation("48:notifications")).toBe(true)
    expect(isReservedConversation("19:aaa@thread.v2")).toBe(false)
  })
  it("derives kind from the id shape", () => {
    expect(conversationKind("19:xyz@unq.gbl.spaces")).toBe("oneOnOne")
    expect(conversationKind("19:aaa@thread.v2")).toBe("group")
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
    // Both cursors initialize to the last-message ts (the anchor t107+ pages from).
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
    // The sync cursor is NOT clobbered by a metadata update (t107+ owns it).
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

  it("skips reserved 48:* / self conversations", () => {
    upsertConversations(db, TENANT, [
      conv(),
      { id: "48:notes", lastUpdatedMessageVersion: 9, lastMessage: { content: "self" } },
      { id: "48:notifications", lastUpdatedMessageVersion: 9 },
    ])
    const ids = listConversations(db, TENANT).map((c) => c.id)
    expect(ids).toEqual(["19:aaa@thread.v2"])
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
