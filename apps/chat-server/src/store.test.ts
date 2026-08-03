import Database from "better-sqlite3"
import { beforeEach, describe, expect, test } from "vitest"
import {
  attributeSend,
  chooseSuggestion,
  deletePushSub,
  dismissSuggestions,
  finishBackfillRun,
  getAllPrefs,
  getFolderOrder,
  getReadState,
  getSuggestionById,
  getSuggestions,
  getUsers,
  listBackfillRuns,
  listConversations,
  listDivergedSends,
  listMessageEdits,
  listMessages,
  listMessagesAfter,
  listMessagesAround,
  listMessagesBefore,
  listPushSubs,
  MAX_BACKFILL_RUNS,
  MAX_SUGGESTION_TEXT_CHARS,
  MAX_SUGGESTION_TEXTS,
  markConversationRead,
  markConversationUnread,
  migrate,
  savePushSub,
  setFolderOrder,
  setPrefs,
  setReadHorizon,
  startBackfillRun,
  upsertConversations,
  upsertMessages,
  upsertUsers,
  writeSuggestions,
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

  test("title round-trips through upsert → listConversations", () => {
    upsertConversations(db, "teams", [{ id: "c", lastMessageVersion: 1, title: "Alice" }])
    expect(listConversations(db, "teams")[0].title).toBe("Alice")
  })

  test("upsert with no/empty title does NOT clobber a stored title", () => {
    upsertConversations(db, "teams", [{ id: "c", lastMessageVersion: 1, title: "Alice" }])
    // Version bump but no title → stored title must survive.
    upsertConversations(db, "teams", [{ id: "c", lastMessageVersion: 2 }])
    expect(listConversations(db, "teams")[0].title).toBe("Alice")
    // Explicit empty string also must not clear it.
    upsertConversations(db, "teams", [{ id: "c", lastMessageVersion: 3, title: "" }])
    expect(listConversations(db, "teams")[0].title).toBe("Alice")
  })

  test("avatarUserId + memberIds round-trip and survive a title-less update", () => {
    upsertConversations(db, "teams", [
      { id: "dm", lastMessageVersion: 1, avatarUserId: "other-oid" },
      { id: "g", lastMessageVersion: 1, memberIds: ["a-oid", "b-oid"] },
    ])
    const byId = () => new Map(listConversations(db, "teams").map((c) => [c.id, c]))
    expect(byId().get("dm")?.avatarUserId).toBe("other-oid")
    expect(byId().get("g")?.memberIds).toEqual(["a-oid", "b-oid"])
    // A later delta that resolved neither must not clear them (absent = unresolved).
    upsertConversations(db, "teams", [
      { id: "dm", lastMessageVersion: 2 },
      { id: "g", lastMessageVersion: 2, memberIds: [] },
    ])
    expect(byId().get("dm")?.avatarUserId).toBe("other-oid")
    expect(byId().get("g")?.memberIds).toEqual(["a-oid", "b-oid"])
  })

  test("an unresolved avatar is omitted, not null", () => {
    upsertConversations(db, "teams", [{ id: "c", lastMessageVersion: 1 }])
    const row = listConversations(db, "teams")[0]
    expect(row.avatarUserId).toBeUndefined()
    expect(row.memberIds).toBeUndefined()
  })

  test("a new non-empty title lands even when lastMessageVersion did not rise", () => {
    upsertConversations(db, "teams", [{ id: "c", lastMessageVersion: 5, lastMessagePreview: "hi" }])
    // Same version — version-gated DO UPDATE won't fire, but title must still land.
    upsertConversations(db, "teams", [{ id: "c", lastMessageVersion: 5, title: "Bob" }])
    const row = listConversations(db, "teams")[0]
    expect(row.title).toBe("Bob")
    // The version-gated fields are unchanged (preview was not overwritten).
    expect(row.lastMessagePreview).toBe("hi")
  })

  test("migrate() on a DB without the title column adds it, and running twice does not throw", () => {
    // Build a DB that mimics a pre-migration state: create the conversations table without `title`.
    const db2 = new Database(":memory:")
    db2.exec(`
      CREATE TABLE conversations (
        service TEXT NOT NULL, id TEXT NOT NULL,
        kind TEXT, topic TEXT,
        last_message_id TEXT, last_message_version INTEGER,
        last_message_ts INTEGER, last_message_preview TEXT,
        last_message_from_me INTEGER DEFAULT 0,
        newest_synced_ts INTEGER, oldest_synced_ts INTEGER,
        muted INTEGER DEFAULT 0, updated_at INTEGER,
        PRIMARY KEY (service, id)
      )
    `)
    expect(() => {
      migrate(db2)
      migrate(db2) // second call must not throw
    }).not.toThrow()
    const cols = (db2.prepare("PRAGMA table_info(conversations)").all() as { name: string }[]).map(
      (r) => r.name,
    )
    expect(cols).toContain("title")
  })

  // PSN-113 C-fix: lastMessageSender is resolved from `lastMessage.from` at the
  // /internal/teams seam and persisted on the row — no read-time JOIN on `messages`.
  test("lastMessageSender is persisted from conv.lastMessageSender on upsert", () => {
    upsertConversations(db, "teams", [
      {
        id: "g1",
        kind: "group",
        lastMessageId: "m1",
        lastMessageVersion: 1,
        lastMessageTs: 100,
        lastMessageSender: "Glory Nguyen - Group Office",
      },
    ])
    // The row surfaces the stored name without needing the message row synced.
    const row = listConversations(db, "teams").find((c) => c.id === "g1")
    expect(row?.lastMessageSender).toBe("Glory Nguyen - Group Office")
  })

  test("lastMessageSender is absent when never provided", () => {
    upsertConversations(db, "teams", [
      { id: "g2", kind: "group", lastMessageId: "m1", lastMessageVersion: 1, lastMessageTs: 100 },
    ])
    const row = listConversations(db, "teams").find((c) => c.id === "g2")
    expect(row?.lastMessageSender).toBeUndefined()
  })

  // COALESCE contract (matches `title` / `avatarUserId`): an absent incoming sender never
  // clears a previously-resolved name — a list fetch that omits the field can't undo Graph.
  test("lastMessageSender absent on a later upsert keeps the stored name", () => {
    upsertConversations(db, "teams", [
      {
        id: "g3",
        kind: "group",
        lastMessageVersion: 1,
        lastMessageTs: 100,
        lastMessageSender: "Alice Wong",
      },
    ])
    upsertConversations(db, "teams", [
      { id: "g3", kind: "group", lastMessageVersion: 2, lastMessageTs: 200 },
    ])
    const row = listConversations(db, "teams").find((c) => c.id === "g3")
    expect(row?.lastMessageSender).toBe("Alice Wong")
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

describe("jump windows (t175)", () => {
  let db: Database.Database
  beforeEach(() => {
    db = freshDb()
    upsertMessages(
      db,
      "teams",
      "c1",
      Array.from({ length: 20 }, (_, i) => ({
        id: `m${i + 1}`,
        ts: (i + 1) * 100,
        body: `msg ${i + 1}`,
        raw: { service: "teams", id: `m${i + 1}`, ts: (i + 1) * 100, body: `msg ${i + 1}` },
      })),
    )
  })

  test("around: window brackets the target with correct flags", () => {
    const win = listMessagesAround(db, "teams", "c1", "m10", 6)
    expect(win).not.toBeNull()
    const ids = (win?.messages ?? []).map((m) => m.id)
    expect(ids).toContain("m10")
    expect(ids[0] < ids[ids.length - 1] || ids.length > 1).toBe(true)
    expect(win?.hasOlder).toBe(true)
    expect(win?.hasNewer).toBe(true)
  })

  test("around: missing target → null; edges clear flags", () => {
    expect(listMessagesAround(db, "teams", "c1", "nope")).toBeNull()
    const newest = listMessagesAround(db, "teams", "c1", "m20", 6)
    expect(newest?.hasNewer).toBe(false)
    const oldest = listMessagesAround(db, "teams", "c1", "m1", 6)
    expect(oldest?.hasOlder).toBe(false)
  })

  test("after: ascending pages walk to newest, hasNewer flips at the end", () => {
    const p1 = listMessagesAfter(db, "teams", "c1", 500, 5)
    expect(p1.messages.map((m) => m.id)).toEqual(["m6", "m7", "m8", "m9", "m10"])
    expect(p1.hasNewer).toBe(true)
    const p2 = listMessagesAfter(db, "teams", "c1", 1500, 10)
    expect(p2.messages.map((m) => m.id)).toEqual(["m16", "m17", "m18", "m19", "m20"])
    expect(p2.hasNewer).toBe(false)
  })

  test("before: older page oldest→newest with hasOlder flag", () => {
    const p = listMessagesBefore(db, "teams", "c1", 500, 3)
    expect(p.messages.map((m) => m.id)).toEqual(["m2", "m3", "m4"])
    expect(p.hasOlder).toBe(true)
    const end = listMessagesBefore(db, "teams", "c1", 200, 5)
    expect(end.messages.map((m) => m.id)).toEqual(["m1"])
    expect(end.hasOlder).toBe(false)
  })
})

describe("edit history (PSN-105 C)", () => {
  let db: Database.Database
  beforeEach(() => {
    db = freshDb()
    upsertConversations(db, "teams", [{ id: "c", lastMessageVersion: 1 }])
  })

  test("snapshots the old body on every observed edit, newest first", () => {
    upsertMessages(db, "teams", "c", [{ id: "a", ts: 100, body: "v1" }])
    upsertMessages(db, "teams", "c", [{ id: "a", ts: 100, body: "v2", edited: true, editTs: 111 }])
    upsertMessages(db, "teams", "c", [{ id: "a", ts: 100, body: "v3", edited: true, editTs: 222 }])
    const { versions } = listMessageEdits(db, "teams", "c", "a")
    expect(versions.map((v) => v.body)).toEqual(["v2", "v1"])
    expect(versions[0].editTs).toBe(222)
    expect(listMessages(db, "teams", "c")[0].body).toBe("v3")
  })

  test("recovers the text of a deleted message, and records nothing on a re-sweep", () => {
    upsertMessages(db, "teams", "c", [{ id: "a", ts: 100, body: "secret" }])
    upsertMessages(db, "teams", "c", [{ id: "a", ts: 100, body: "message deleted", deleted: true }])
    upsertMessages(db, "teams", "c", [{ id: "a", ts: 100, body: "message deleted", deleted: true }])
    expect(listMessageEdits(db, "teams", "c", "a").versions.map((v) => v.body)).toEqual(["secret"])
  })

  // QE DEF-1 (data loss): a blank incoming body used to overwrite the row AND skip the snapshot,
  // so the original text was gone from both places. It must survive in the row.
  test("a blank incoming body never erases a live message", () => {
    upsertMessages(db, "teams", "c", [{ id: "a", ts: 100, body: "hi there" }])
    upsertMessages(db, "teams", "c", [{ id: "a", ts: 100, body: "", edited: true }])
    expect(listMessages(db, "teams", "c")[0].body).toBe("hi there")
    expect(listMessageEdits(db, "teams", "c", "a").versions).toHaveLength(0)
    // …and a later real edit still records the untouched original.
    upsertMessages(db, "teams", "c", [{ id: "a", ts: 100, body: "v2", edited: true }])
    expect(listMessageEdits(db, "teams", "c", "a").versions.map((v) => v.body)).toEqual([
      "hi there",
    ])
  })

  test("a delete still blanks the body, whatever tombstone the provider sends", () => {
    upsertMessages(db, "teams", "c", [{ id: "a", ts: 100, body: "mock style" }])
    upsertMessages(db, "teams", "c", [{ id: "a", ts: 100, body: "", deleted: true }])
    expect(listMessages(db, "teams", "c")[0].body).toBe("")
    expect(listMessageEdits(db, "teams", "c", "a").versions.map((v) => v.body)).toEqual([
      "mock style",
    ])
  })

  test("the raw payload follows the persisted body, so a rejected blank can't leak back", () => {
    upsertMessages(db, "teams", "c", [
      { id: "a", ts: 100, body: "hi there", raw: { body: "hi there" } },
    ])
    upsertMessages(db, "teams", "c", [{ id: "a", ts: 100, body: "", raw: { body: "" } }])
    expect((listMessages(db, "teams", "c")[0].raw as { body: string }).body).toBe("hi there")
  })

  test("caps the stored versions per message", () => {
    upsertMessages(db, "teams", "c", [{ id: "a", ts: 100, body: "v0" }])
    for (let i = 1; i <= 25; i++) {
      upsertMessages(db, "teams", "c", [{ id: "a", ts: 100, body: `v${i}`, edited: true }])
    }
    const { versions, truncated } = listMessageEdits(db, "teams", "c", "a")
    expect(versions).toHaveLength(20)
    expect(versions[0].body).toBe("v24")
    expect(truncated).toBe(true)
  })

  // QE DEF-5: exactly-at-the-cap claimed older versions were dropped when none were.
  test("reports truncation only once a version was actually dropped", () => {
    upsertMessages(db, "teams", "c", [{ id: "a", ts: 100, body: "v0" }])
    for (let i = 1; i <= 20; i++) {
      upsertMessages(db, "teams", "c", [{ id: "a", ts: 100, body: `v${i}`, edited: true }])
    }
    const at = listMessageEdits(db, "teams", "c", "a")
    expect(at.versions).toHaveLength(20)
    expect(at.versions[19].body).toBe("v0") // the oldest kept IS the original
    expect(at.truncated).toBe(false)

    upsertMessages(db, "teams", "c", [{ id: "a", ts: 100, body: "v21", edited: true }])
    const over = listMessageEdits(db, "teams", "c", "a")
    expect(over.versions).toHaveLength(20)
    expect(over.truncated).toBe(true)
  })
})

describe("backfill run history (PSN-105 N)", () => {
  let db: Database.Database
  beforeEach(() => {
    db = freshDb()
  })

  test("an unfinished run reads as aborted until an outcome is written", () => {
    const id = startBackfillRun(db, "teams", 30, 1000)
    expect(listBackfillRuns(db, "teams")).toEqual([
      {
        id,
        startedAt: 1000,
        finishedAt: null,
        days: 30,
        conversations: 0,
        messages: 0,
        status: "aborted",
      },
    ])
    finishBackfillRun(db, id, { conversations: 3, messages: 40, status: "ok" }, 2000)
    expect(listBackfillRuns(db, "teams")[0]).toMatchObject({
      finishedAt: 2000,
      conversations: 3,
      messages: 40,
      status: "ok",
    })
  })

  test("keeps an error code, newest first, capped per service", () => {
    const bad = startBackfillRun(db, "teams", 7, 10)
    finishBackfillRun(
      db,
      bad,
      { conversations: 1, messages: 2, status: "error", error: "rate_limited" },
      20,
    )
    for (let i = 0; i < MAX_BACKFILL_RUNS + 5; i++) startBackfillRun(db, "teams", 1, 100 + i)
    startBackfillRun(db, "other", 1, 999)

    const runs = listBackfillRuns(db, "teams")
    expect(runs).toHaveLength(MAX_BACKFILL_RUNS)
    expect(runs[0].startedAt).toBeGreaterThan(runs[1].startedAt) // newest first
    expect(runs.some((r) => r.id === bad)).toBe(false) // the oldest fell off the cap
    expect(listBackfillRuns(db, "other")).toHaveLength(1) // another service is untouched
  })
})

describe("reply suggestions (ADR-0027)", () => {
  let db: Database.Database
  beforeEach(() => {
    db = freshDb()
  })

  const write = (convId = "c1", texts = ["one", "two", "three"], forMsgId: string | null = "m9") =>
    writeSuggestions(db, "teams", { convId, texts, producer: "hermes", forMsgId })

  test("stores a batch and reads it back as the live one", () => {
    const b = write()
    expect(b.texts).toEqual(["one", "two", "three"])
    expect(b.status).toBe("open")
    expect(b.producer).toBe("hermes")
    expect(b.forMsgId).toBe("m9")
    expect(b.chosenIdx).toBeNull()
    expect(getSuggestions(db, "teams", "c1")).toEqual(b)
  })

  test("a new batch supersedes the live one — never two live at once", () => {
    const first = write("c1", ["a"])
    const second = write("c1", ["b"])
    expect(getSuggestionById(db, "teams", first.id)?.status).toBe("superseded")
    expect(getSuggestions(db, "teams", "c1")?.id).toBe(second.id)
    const live = db
      .prepare(
        "SELECT COUNT(*) n FROM reply_suggestions WHERE conv_id = 'c1' AND status IN ('open','chosen')",
      )
      .get() as { n: number }
    expect(live.n).toBe(1)
  })

  test("supersede is scoped to the conversation and the service", () => {
    const other = write("c2", ["keep me"])
    const otherService = writeSuggestions(db, "slack", {
      convId: "c1",
      texts: ["different service"],
      producer: "hermes",
    })
    write("c1", ["new"])
    expect(getSuggestionById(db, "teams", other.id)?.status).toBe("open")
    expect(getSuggestionById(db, "slack", otherService.id)?.status).toBe("open")
  })

  test("choosing records the index without touching the texts", () => {
    const b = write()
    const after = chooseSuggestion(db, "teams", b.id, 2)
    expect(after?.status).toBe("chosen")
    expect(after?.chosenIdx).toBe(2)
    expect(after?.chosenAt).toBeGreaterThan(0)
    expect(after?.texts).toEqual(b.texts)
    // still live: chosen batches stay readable so a send can be attributed to them later
    expect(getSuggestions(db, "teams", "c1")?.id).toBe(b.id)
  })

  test("re-choosing overwrites — inserted one, changed his mind, inserted another", () => {
    const b = write()
    chooseSuggestion(db, "teams", b.id, 0)
    expect(chooseSuggestion(db, "teams", b.id, 1)?.chosenIdx).toBe(1)
  })

  test("an out-of-range index throws instead of storing a dangling pointer", () => {
    const b = write("c1", ["only one"])
    expect(() => chooseSuggestion(db, "teams", b.id, 1)).toThrow(/out of range/)
    expect(() => chooseSuggestion(db, "teams", b.id, -1)).toThrow(/out of range/)
    expect(getSuggestionById(db, "teams", b.id)?.chosenIdx).toBeNull()
  })

  test("choosing an unknown batch returns null rather than throwing", () => {
    expect(chooseSuggestion(db, "teams", 9999, 0)).toBeNull()
  })

  test("dismiss retires the batch but keeps the row — a dismissal is itself a signal", () => {
    const b = write()
    dismissSuggestions(db, "teams", b.id)
    expect(getSuggestions(db, "teams", "c1")).toBeNull()
    expect(getSuggestionById(db, "teams", b.id)?.status).toBe("dismissed")
  })

  test("empty or blank-only texts are rejected — an empty strip is unactionable", () => {
    expect(() => write("c1", [])).toThrow(/at least one/)
    expect(() => write("c1", ["", "   "])).toThrow(/at least one/)
  })

  test("blank entries are dropped, real ones trimmed", () => {
    expect(write("c1", ["  hello  ", "", "world"]).texts).toEqual(["hello", "world"])
  })

  test("a producer is required — an unattributed batch is untraceable", () => {
    expect(() =>
      writeSuggestions(db, "teams", { convId: "c1", texts: ["x"], producer: "  " }),
    ).toThrow(/producer/)
  })

  // /api/chat/* is unauthenticated, and an accepted batch is broadcast to every connected client.
  // Without ceilings one POST costs memory on all of them plus a permanent oversized row.
  test(`rejects more than ${MAX_SUGGESTION_TEXTS} texts`, () => {
    const many = Array.from({ length: MAX_SUGGESTION_TEXTS + 1 }, (_, i) => `s${i}`)
    expect(() => write("c1", many)).toThrow(/at most/)
    expect(write("c1", many.slice(0, MAX_SUGGESTION_TEXTS)).texts).toHaveLength(
      MAX_SUGGESTION_TEXTS,
    )
  })

  test(`rejects a text longer than ${MAX_SUGGESTION_TEXT_CHARS} chars`, () => {
    expect(() => write("c1", ["ok", "x".repeat(MAX_SUGGESTION_TEXT_CHARS + 1)])).toThrow(/<=/)
    expect(write("c1", ["x".repeat(MAX_SUGGESTION_TEXT_CHARS)]).texts[0]).toHaveLength(
      MAX_SUGGESTION_TEXT_CHARS,
    )
  })

  test("manual generate stores a null forMsgId", () => {
    expect(write("c1", ["x"], null).forMsgId).toBeNull()
  })

  test("a corrupt texts blob degrades to an empty batch, it does not throw", () => {
    const b = write()
    db.prepare("UPDATE reply_suggestions SET texts = ? WHERE id = ?").run("{not json", b.id)
    expect(getSuggestionById(db, "teams", b.id)?.texts).toEqual([])
  })

  test("no batch for an untouched conversation", () => {
    expect(getSuggestions(db, "teams", "never-seen")).toBeNull()
  })
})

describe("send attribution (PSN-145)", () => {
  let db: Database.Database
  beforeEach(() => {
    db = freshDb()
  })

  const write = (convId = "c1", texts = ["one", "two", "three"]) =>
    writeSuggestions(db, "teams", { convId, texts, producer: "hermes", forMsgId: "m9" })

  test("choose then send records the sent text against the batch", () => {
    const b = write()
    chooseSuggestion(db, "teams", b.id, 1)
    const after = attributeSend(db, "teams", "c1", { msgId: "sent-1", text: "two, but edited" })
    expect(after?.sentMsgId).toBe("sent-1")
    expect(after?.sentText).toBe("two, but edited")
    expect(after?.sentAt).toBeGreaterThan(0)
    // The pair is the point: what was offered vs what actually went out.
    expect(after?.texts[after.chosenIdx as number]).toBe("two")
  })

  test("only the FIRST send attributes — a follow-up message is a different message", () => {
    const b = write()
    chooseSuggestion(db, "teams", b.id, 0)
    attributeSend(db, "teams", "c1", { msgId: "sent-1", text: "first" })
    expect(attributeSend(db, "teams", "c1", { msgId: "sent-2", text: "second" })).toBeNull()
    expect(getSuggestionById(db, "teams", b.id)?.sentText).toBe("first")
  })

  test("a send with no chosen batch records nothing and does not throw", () => {
    write() // open, never chosen
    expect(attributeSend(db, "teams", "c1", { msgId: "s", text: "typed from scratch" })).toBeNull()
    expect(getSuggestions(db, "teams", "c1")?.sentAt).toBeNull()
  })

  test("status is the gate, not the timestamp — an open row with a chosen_at still refuses", () => {
    // Pins WHY both guards exist. An `open` batch normally has a null `chosen_at`, so the window
    // check would refuse this anyway (`at - null` is huge) — which means a mutation that deletes
    // the status check survives unless the two are separated. Hand-set the timestamp to separate
    // them: status is the decision, the timestamp only bounds it.
    const b = write()
    db.prepare("UPDATE reply_suggestions SET chosen_at = ? WHERE id = ?").run(Date.now(), b.id)
    expect(getSuggestionById(db, "teams", b.id)?.status).toBe("open")
    expect(attributeSend(db, "teams", "c1", { msgId: "s", text: "never picked" })).toBeNull()
  })

  test("a send into a conversation that never had suggestions is a no-op", () => {
    expect(attributeSend(db, "teams", "never-seen", { msgId: "s", text: "hi" })).toBeNull()
  })

  test("a dismissed batch does not attribute — he rejected it, then wrote his own", () => {
    const b = write()
    chooseSuggestion(db, "teams", b.id, 0)
    dismissSuggestions(db, "teams", b.id)
    expect(attributeSend(db, "teams", "c1", { msgId: "s", text: "mine" })).toBeNull()
  })

  test("a send outside the window does not attribute — a morning choice is not an evening send", () => {
    const b = write()
    chooseSuggestion(db, "teams", b.id, 0)
    const chosenAt = getSuggestionById(db, "teams", b.id)?.chosenAt as number
    const late = chosenAt + 11 * 60 * 1000
    expect(
      attributeSend(db, "teams", "c1", { msgId: "s", text: "much later", at: late }),
    ).toBeNull()
    const early = chosenAt + 9 * 60 * 1000
    expect(
      attributeSend(db, "teams", "c1", { msgId: "s", text: "in time", at: early }),
    ).not.toBeNull()
  })

  test("attribution is scoped to the conversation", () => {
    const b = write("c1")
    chooseSuggestion(db, "teams", b.id, 0)
    expect(attributeSend(db, "teams", "c2", { msgId: "s", text: "other thread" })).toBeNull()
    expect(getSuggestionById(db, "teams", b.id)?.sentAt).toBeNull()
  })

  test("attribution is scoped to the service", () => {
    const b = write("c1")
    chooseSuggestion(db, "teams", b.id, 0)
    expect(attributeSend(db, "slack", "c1", { msgId: "s", text: "wrong service" })).toBeNull()
    expect(getSuggestionById(db, "teams", b.id)?.sentAt).toBeNull()
  })

  test("an attributed batch is frozen — re-choosing cannot rewrite the pair", () => {
    const b = write()
    chooseSuggestion(db, "teams", b.id, 0)
    attributeSend(db, "teams", "c1", { msgId: "s", text: "went out" })
    expect(chooseSuggestion(db, "teams", b.id, 2)?.chosenIdx).toBe(0)
  })

  test("diverged list returns only the batches where sent != suggested", () => {
    const exact = write("c1", ["same text"])
    chooseSuggestion(db, "teams", exact.id, 0)
    attributeSend(db, "teams", "c1", { msgId: "s1", text: "same text" })

    const edited = write("c2", ["draft version"])
    chooseSuggestion(db, "teams", edited.id, 0)
    attributeSend(db, "teams", "c2", { msgId: "s2", text: "draft version, but reworded" })

    const rows = listDivergedSends(db, "teams")
    expect(rows.map((r) => r.convId)).toEqual(["c2"])
    expect(rows[0].sentText).toBe("draft version, but reworded")
  })

  test("diverged list ignores batches that were never sent", () => {
    const b = write("c1")
    chooseSuggestion(db, "teams", b.id, 0)
    expect(listDivergedSends(db, "teams")).toEqual([])
  })

  test("diverged list is scoped to the service", () => {
    const b = write("c1", ["a"])
    chooseSuggestion(db, "teams", b.id, 0)
    attributeSend(db, "teams", "c1", { msgId: "s", text: "b" })
    expect(listDivergedSends(db, "slack")).toEqual([])
  })
})
