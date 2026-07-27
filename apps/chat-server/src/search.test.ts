import Database from "better-sqlite3"
import { beforeEach, describe, expect, test } from "vitest"
import {
  backfillSearchIndex,
  fold,
  getContextWindow,
  indexText,
  listConversationsByQuery,
  resolvePerson,
  searchMessages,
  stripHtml,
  toMatchQuery,
} from "./search.ts"
import { migrate, upsertConversations, upsertMessages, upsertUsers } from "./store.ts"

function freshDb() {
  const db = new Database(":memory:")
  migrate(db)
  return db
}

describe("fold", () => {
  test("Vietnamese: đ/Đ, stacked tones, horns", () => {
    expect(fold("Đường Đà Nẵng")).toBe("duong da nang")
    expect(fold("người dùng")).toBe("nguoi dung")
    expect(fold("Việt Nam ơi")).toBe("viet nam oi")
  })
  test("idempotent", () => {
    expect(fold(fold("Đà Nẵng"))).toBe(fold("Đà Nẵng"))
  })
  test("non-Latin passthrough + lowercase", () => {
    expect(fold("日本語 ABC")).toBe("日本語 abc")
    expect(fold("")).toBe("")
  })
})

describe("stripHtml", () => {
  test("drops tags, decodes entities", () => {
    expect(stripHtml("<p>hello <b>world</b></p>")).toBe("hello world")
    expect(stripHtml("a &amp; b &lt;c&gt; &#7853;p")).toBe("a & b <c> ập")
    expect(stripHtml("x&#x111;y")).toBe("xđy")
  })
  test("mention spans keep their text", () => {
    expect(stripHtml('<span class="mention" data-mri="8:x">@Anh Duong</span> hi')).toBe(
      "@Anh Duong hi",
    )
  })
  test("media degrade to alt text or nothing", () => {
    expect(stripHtml('before <img src="x.png" alt="chart"> after')).toBe("before chart after")
    expect(stripHtml('a <img src="x.png"> b <video src="v.mp4"></video> c')).toBe("a b c")
  })
  test("whitespace collapses", () => {
    expect(stripHtml("<p>a</p><p>b</p>")).toBe("a b")
  })
})

describe("indexText", () => {
  test("strips then folds", () => {
    expect(indexText("<p>Đường <b>phố</b></p>")).toBe("duong pho")
  })
})

describe("toMatchQuery", () => {
  test("folds + quotes tokens", () => {
    expect(toMatchQuery("Đường phố")).toBe('"duong" "pho"')
  })
  test("escapes quotes, empty → null", () => {
    expect(toMatchQuery('a"b')).toBe('"a""b"')
    expect(toMatchQuery("   ")).toBeNull()
  })
  test("FTS syntax chars are neutralized", () => {
    expect(toMatchQuery("a AND b*")).toBe('"a" "and" "b*"')
  })
})

describe("searchMessages", () => {
  let db: Database.Database
  beforeEach(() => {
    db = freshDb()
    upsertMessages(db, "teams", "c1", [
      { id: "m1", ts: 1000, senderId: "u1", senderName: "Dương", body: "<p>Đường Đà Nẵng đẹp</p>" },
      { id: "m2", ts: 2000, senderId: "u2", senderName: "Bob", body: "deploy is done" },
      { id: "m3", ts: 3000, senderId: "u1", senderName: "Dương", body: "về deploy ngày mai" },
    ])
    upsertMessages(db, "teams", "c2", [
      { id: "m4", ts: 4000, senderId: "u2", senderName: "Bob", body: "deploy c2 talk" },
    ])
  })

  test("ASCII query hits diacritic text", () => {
    const hits = searchMessages(db, { query: "duong da nang" })
    expect(hits.map((h) => h.msgId)).toEqual(["m1"])
    expect(hits[0].snippet).toContain("Đường Đà Nẵng")
    expect(hits[0].convId).toBe("c1")
  })

  test("diacritic query hits its own text", () => {
    expect(searchMessages(db, { query: "Đà Nẵng" }).map((h) => h.msgId)).toEqual(["m1"])
  })

  test("đ found from d-query", () => {
    expect(searchMessages(db, { query: "dep" }).map((h) => h.msgId)).toEqual(["m1"])
  })

  test("filters: sender, convId, time range, limit", () => {
    expect(searchMessages(db, { query: "deploy", sender: "u1" }).map((h) => h.msgId)).toEqual([
      "m3",
    ])
    expect(searchMessages(db, { query: "deploy", convId: "c2" }).map((h) => h.msgId)).toEqual([
      "m4",
    ])
    expect(
      searchMessages(db, { query: "deploy", after: 2500, before: 3500 }).map((h) => h.msgId),
    ).toEqual(["m3"])
    expect(searchMessages(db, { query: "deploy", limit: 1 })).toHaveLength(1)
  })

  test("edit re-indexes, delete drops from index", () => {
    upsertMessages(db, "teams", "c1", [{ id: "m2", ts: 2000, body: "rollback instead" }])
    expect(searchMessages(db, { query: "deploy" }).map((h) => h.msgId)).not.toContain("m2")
    expect(searchMessages(db, { query: "rollback" }).map((h) => h.msgId)).toEqual(["m2"])
    upsertMessages(db, "teams", "c1", [{ id: "m2", ts: 2000, body: "", deleted: true }])
    expect(searchMessages(db, { query: "rollback" })).toHaveLength(0)
  })

  test("empty query → []", () => {
    expect(searchMessages(db, { query: "  " })).toEqual([])
  })
})

describe("backfillSearchIndex", () => {
  test("indexes pre-existing rows once, idempotent", () => {
    // Simulate rows written before the index existed: insert directly, bypassing upsertMessages.
    const db = freshDb()
    db.prepare(
      "INSERT INTO messages (service, conv_id, id, ts, body, deleted) VALUES ('teams','c1','old1',10,'<p>tin nhắn cũ</p>',0)",
    ).run()
    db.prepare(
      "INSERT INTO messages (service, conv_id, id, ts, body, deleted) VALUES ('teams','c1','old2',20,'gone',1)",
    ).run()
    expect(backfillSearchIndex(db)).toBe(1)
    expect(backfillSearchIndex(db)).toBe(0)
    expect(searchMessages(db, { query: "tin nhan cu" }).map((h) => h.msgId)).toEqual(["old1"])
    const count = db.prepare("SELECT COUNT(*) AS n FROM messages_fts").get() as { n: number }
    expect(count.n).toBe(1)
  })

  test("migrate twice keeps index count stable", () => {
    const db = freshDb()
    upsertMessages(db, "teams", "c1", [{ id: "m1", ts: 1, body: "hello" }])
    migrate(db)
    const count = db.prepare("SELECT COUNT(*) AS n FROM messages_fts").get() as { n: number }
    expect(count.n).toBe(1)
  })
})

describe("getContextWindow", () => {
  let db: Database.Database
  beforeEach(() => {
    db = freshDb()
    upsertMessages(
      db,
      "teams",
      "c1",
      Array.from({ length: 10 }, (_, i) => ({
        id: `m${i + 1}`,
        ts: (i + 1) * 100,
        body: `msg ${i + 1}`,
      })),
    )
  })

  test("around a target", () => {
    const win = getContextWindow(db, "teams", { convId: "c1", aroundMsgId: "m5", limit: 4 })
    const ids = win.map((m) => m.msgId)
    expect(ids).toContain("m5")
    expect(ids).toEqual(["m3", "m4", "m5", "m6", "m7"])
    expect(win[0].text).toBe("msg 3")
  })

  test("missing target → []", () => {
    expect(getContextWindow(db, "teams", { convId: "c1", aroundMsgId: "nope" })).toEqual([])
  })

  test("beforeTs pages older, default newest", () => {
    const newest = getContextWindow(db, "teams", { convId: "c1", limit: 3 })
    expect(newest.map((m) => m.msgId)).toEqual(["m8", "m9", "m10"])
    const older = getContextWindow(db, "teams", { convId: "c1", beforeTs: 400, limit: 2 })
    expect(older.map((m) => m.msgId)).toEqual(["m2", "m3"])
  })

  test("deleted message shows empty text + flag", () => {
    upsertMessages(db, "teams", "c1", [{ id: "m5", ts: 500, body: "", deleted: true }])
    const win = getContextWindow(db, "teams", { convId: "c1", aroundMsgId: "m4", limit: 2 })
    const m5 = win.find((m) => m.msgId === "m5")
    expect(m5?.deleted).toBe(true)
    expect(m5?.text).toBe("")
  })
})

describe("listConversationsByQuery", () => {
  test("fold-matched over title/topic, newest-first", () => {
    const db = freshDb()
    upsertConversations(db, "teams", [
      { id: "c1", title: "Đội Đà Nẵng", lastMessageVersion: 1, lastMessageTs: 100 },
      { id: "c2", topic: "Deploy talk", lastMessageVersion: 1, lastMessageTs: 200 },
    ])
    expect(listConversationsByQuery(db, "teams", { query: "da nang" }).map((c) => c.id)).toEqual([
      "c1",
    ])
    const all = listConversationsByQuery(db, "teams")
    expect(all.map((c) => c.id)).toEqual(["c2", "c1"])
  })
})

describe("resolvePerson", () => {
  test("fold-matched over users cache", () => {
    const db = freshDb()
    upsertUsers(db, "teams", [
      { id: "u1", displayName: "Dương Đỗ" },
      { id: "u2", displayName: "Bob Smith" },
    ])
    expect(resolvePerson(db, "teams", { name: "duong" })).toEqual([
      { id: "u1", displayName: "Dương Đỗ" },
    ])
    expect(resolvePerson(db, "teams", { name: "" })).toEqual([])
  })
})

describe("mentionsMe filter (steering: 'who mentioned me')", () => {
  let db: Database.Database
  beforeEach(() => {
    db = freshDb()
    upsertMessages(db, "teams", "c1", [
      // A real @-mention: the flag is set AND the rendered body carries the name.
      {
        id: "m1",
        ts: 1000,
        senderName: "Bob",
        body: '<p><span class="mention">@Dustin Do</span> can you review?</p>',
        mentionsMe: true,
      },
      // Someone merely TALKING about the user — a name search matches this, a mention search must not.
      { id: "m2", ts: 2000, senderName: "Ann", body: "<p>Dustin is on leave today</p>" },
      // A mention under a different display name — a name search misses this, the flag catches it.
      {
        id: "m3",
        ts: 3000,
        senderName: "Cara",
        body: '<p><span class="mention">@Đường</span> ping</p>',
        mentionsMe: true,
      },
    ])
  })

  test("a plain name query is NOT equivalent to mentions", () => {
    const byName = searchMessages(db, { query: "Dustin" })
      .map((h) => h.msgId)
      .sort()
    expect(byName).toEqual(["m1", "m2"]) // false positive m2, missing m3
  })

  test("mentionsMe returns exactly the tagged messages", () => {
    const tagged = searchMessages(db, { query: "review ping can", mentionsMe: true })
    expect(searchMessages(db, { query: "ping", mentionsMe: true }).map((h) => h.msgId)).toEqual([
      "m3",
    ])
    expect(tagged.every((h) => h.msgId !== "m2")).toBe(true)
    const all = searchMessages(db, { query: "a", mentionsMe: true })
    expect(all.every((h) => h.msgId !== "m2")).toBe(true)
  })
})
