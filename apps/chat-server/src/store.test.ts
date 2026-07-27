import Database from "better-sqlite3"
import { beforeEach, describe, expect, test } from "vitest"
import {
  deletePushSub,
  getAllPrefs,
  getFolderOrder,
  getReadState,
  getUsers,
  listConversations,
  listMessages,
  listPushSubs,
  markConversationRead,
  markConversationUnread,
  migrate,
  savePushSub,
  setFolderOrder,
  setPrefs,
  setReadHorizon,
  upsertConversations,
  upsertMessages,
  upsertUsers,
} from "./store.ts"

function freshDb() {
  const db = new Database(":memory:")
  migrate(db)
  return db
}

describe("migrate", () => {
  test("is idempotent", () => {
    const db = new Database(":memory:")
    expect(() => {
      migrate(db)
      migrate(db)
      migrate(db)
    }).not.toThrow()
  })
})

describe("conversations", () => {
  let db: Database.Database
  beforeEach(() => {
    db = freshDb()
  })

  test("upsert + list roundtrip", () => {
    upsertConversations(db, "teams", [
      {
        id: "conv-1",
        kind: "group",
        topic: "Design",
        lastMessageId: "m1",
        lastMessageVersion: 5,
        lastMessageTs: 1000,
        lastMessagePreview: "hi",
      },
    ])
    const list = listConversations(db, "teams")
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      service: "teams",
      id: "conv-1",
      kind: "group",
      topic: "Design",
      lastMessageTs: 1000,
      lastMessagePreview: "hi",
      unreadSticky: false,
    })
  })

  test("service isolation — teams rows don't collide with another service", () => {
    upsertConversations(db, "teams", [
      { id: "shared-id", lastMessageVersion: 1, lastMessageTs: 100 },
    ])
    upsertConversations(db, "slack", [
      { id: "shared-id", lastMessageVersion: 1, lastMessageTs: 200 },
    ])
    const teams = listConversations(db, "teams")
    const slack = listConversations(db, "slack")
    expect(teams).toHaveLength(1)
    expect(slack).toHaveLength(1)
    expect(teams[0].lastMessageTs).toBe(100)
    expect(slack[0].lastMessageTs).toBe(200)
  })

  test("version-gated upsert skips an older version", () => {
    upsertConversations(db, "teams", [
      { id: "c", lastMessageVersion: 5, lastMessagePreview: "new" },
    ])
    upsertConversations(db, "teams", [
      { id: "c", lastMessageVersion: 3, lastMessagePreview: "stale" },
    ])
    expect(listConversations(db, "teams")[0].lastMessagePreview).toBe("new")
    upsertConversations(db, "teams", [
      { id: "c", lastMessageVersion: 6, lastMessagePreview: "newer" },
    ])
    expect(listConversations(db, "teams")[0].lastMessagePreview).toBe("newer")
  })

  test("skips reserved 48:* conversations but keeps 48:notes", () => {
    upsertConversations(db, "teams", [
      { id: "48:notifications", lastMessageVersion: 1 },
      { id: "48:mentions", lastMessageVersion: 1 },
      { id: "48:notes", lastMessageVersion: 1, lastMessageTs: 1 },
    ])
    const ids = listConversations(db, "teams").map((c) => c.id)
    expect(ids).toEqual(["48:notes"])
  })

  test("ingests readHorizonTs into read_state", () => {
    upsertConversations(db, "teams", [{ id: "c", lastMessageVersion: 1, readHorizonTs: 5000 }])
    expect(getReadState(db, "teams", "c")?.readHorizonTs).toBe(5000)
  })
})

describe("read state", () => {
  let db: Database.Database
  beforeEach(() => {
    db = freshDb()
    upsertConversations(db, "teams", [{ id: "c", lastMessageVersion: 1, lastMessageTs: 10_000 }])
  })

  test("mark-unread bookmark survives a horizon advance", () => {
    markConversationUnread(db, "teams", "c", 10_000)
    // A read-elsewhere horizon that covers the last message must NOT clear the bookmark — the
    // horizon can only move forward, so it can never express "unread again".
    setReadHorizon(db, "teams", "c", 20_000)
    const row = listConversations(db, "teams")[0]
    expect(row.unreadSticky).toBe(true)
    expect(row.readTs).toBe(9_999) // one tick below the flagged message
  })

  test("a sweep re-syncing the service's own state is authoritative both ways", () => {
    // Marked unread elsewhere → the sweep carries the bookmark in alongside the advanced horizon.
    upsertConversations(db, "teams", [
      {
        id: "c",
        lastMessageVersion: 2,
        lastMessageTs: 20_000,
        readHorizonTs: 20_000,
        unreadBookmarkTs: 20_000,
      },
    ])
    expect(listConversations(db, "teams")[0].unreadSticky).toBe(true)
    // …then read elsewhere → the bookmark comes back cleared (0) and the row reads again.
    upsertConversations(db, "teams", [
      { id: "c", lastMessageVersion: 3, lastMessageTs: 20_000, unreadBookmarkTs: 0 },
    ])
    const row = listConversations(db, "teams")[0]
    expect(row.unreadSticky).toBe(false)
    expect(row.readTs).toBe(20_000)
  })

  test("explicit mark-read clears the bookmark", () => {
    markConversationUnread(db, "teams", "c", 10_000)
    markConversationRead(db, "teams", "c", 10_000)
    const row = listConversations(db, "teams")[0]
    expect(row.unreadSticky).toBe(false)
    expect(row.readTs).toBe(10_000)
  })
})

describe("messages", () => {
  let db: Database.Database
  beforeEach(() => {
    db = freshDb()
    upsertConversations(db, "teams", [{ id: "c", lastMessageVersion: 1 }])
  })

  test("upsert + list roundtrip, newest first", () => {
    upsertMessages(db, "teams", "c", [
      { id: "a", ts: 100, body: "first" },
      { id: "b", ts: 200, body: "second" },
    ])
    const msgs = listMessages(db, "teams", "c")
    expect(msgs.map((m) => m.id)).toEqual(["b", "a"])
    expect(msgs[0].body).toBe("second")
  })

  test("raw column is preserved and parsed back", () => {
    const rawPayload = {
      messagetype: "RichText/Html",
      properties: { emotions: [] },
      nested: { a: 1 },
    }
    upsertMessages(db, "teams", "c", [{ id: "a", ts: 100, body: "text", raw: rawPayload }])
    const [m] = listMessages(db, "teams", "c")
    expect(m.raw).toEqual(rawPayload)
  })

  test("before cursor pages older", () => {
    upsertMessages(db, "teams", "c", [
      { id: "a", ts: 100 },
      { id: "b", ts: 200 },
      { id: "c2", ts: 300 },
    ])
    const older = listMessages(db, "teams", "c", { before: 300 })
    expect(older.map((m) => m.id)).toEqual(["b", "a"])
  })

  test("mentions_me counts toward mentionCount above the read watermark", () => {
    upsertMessages(db, "teams", "c", [
      { id: "a", ts: 100, mentionsMe: true },
      { id: "b", ts: 200, mentionsMe: true },
    ])
    expect(listConversations(db, "teams")[0].mentionCount).toBe(2)
    markConversationRead(db, "teams", "c", 150)
    expect(listConversations(db, "teams")[0].mentionCount).toBe(1)
  })
})

describe("users", () => {
  test("upsert + get, service isolated", () => {
    const db = freshDb()
    upsertUsers(db, "teams", [{ id: "u1", displayName: "Alice" }])
    upsertUsers(db, "teams", [{ id: "u2", displayName: "" }]) // blank name skipped
    const map = getUsers(db, "teams", ["u1", "u2", "missing"])
    expect(map.get("u1")).toBe("Alice")
    expect(map.has("u2")).toBe(false)
    expect(getUsers(db, "slack", ["u1"]).size).toBe(0)
  })
})

describe("prefs", () => {
  let db: Database.Database
  beforeEach(() => {
    db = freshDb()
  })

  test("patch merges — only provided keys change, shape-guarded", () => {
    setPrefs(db, "teams", "c", { labels: ["  work  ", "work", "", "urgent"], folder: " Inbox " })
    let p = getPrefs2("c")
    expect(p.labels).toEqual(["work", "urgent"]) // trimmed, deduped, empties dropped
    expect(p.folder).toBe("Inbox")
    // Patch only muted — labels/folder untouched.
    setPrefs(db, "teams", "c", { muted: true })
    p = getPrefs2("c")
    expect(p.muted).toBe(true)
    expect(p.labels).toEqual(["work", "urgent"])
    expect(p.folder).toBe("Inbox")

    function getPrefs2(id: string) {
      return getAllPrefs(db, "teams")[id]
    }
  })

  test("mute forever clears a stale mutedUntil", () => {
    setPrefs(db, "teams", "c", { muted: true, mutedUntil: 9999 })
    expect(getAllPrefs(db, "teams").c.mutedUntil).toBe(9999)
    setPrefs(db, "teams", "c", { muted: true }) // no mutedUntil → forever
    expect(getAllPrefs(db, "teams").c.mutedUntil).toBe(null)
  })

  test("customTitle clears on empty string", () => {
    setPrefs(db, "teams", "c", { customTitle: "Renamed" })
    expect(getAllPrefs(db, "teams").c.customTitle).toBe("Renamed")
    setPrefs(db, "teams", "c", { customTitle: "  " })
    expect(getAllPrefs(db, "teams").c.customTitle).toBe(null)
  })
})

describe("folder order", () => {
  test("roundtrip, cleaned, service isolated", () => {
    const db = freshDb()
    const out = setFolderOrder(db, "teams", ["A", "", "  ", "B"])
    expect(out).toEqual(["A", "B"])
    expect(getFolderOrder(db, "teams")).toEqual(["A", "B"])
    expect(getFolderOrder(db, "slack")).toEqual([])
  })
})

describe("push subs", () => {
  test("save + list + delete, service isolated", () => {
    const db = freshDb()
    savePushSub(db, "teams", {
      endpoint: "e1",
      deviceId: "d1",
      subscription: { keys: { p256dh: "x" } },
    })
    savePushSub(db, "teams", { endpoint: "e2", subscription: { keys: {} } })
    expect(listPushSubs(db, "teams")).toHaveLength(2)
    const [s1] = listPushSubs(db, "teams").filter((s) => s.endpoint === "e1")
    expect(s1.deviceId).toBe("d1")
    expect(s1.subscription).toEqual({ keys: { p256dh: "x" } })
    deletePushSub(db, "teams", "e1")
    expect(listPushSubs(db, "teams").map((s) => s.endpoint)).toEqual(["e2"])
    expect(listPushSubs(db, "slack")).toHaveLength(0)
  })
})
