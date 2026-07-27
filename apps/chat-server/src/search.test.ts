import Database from "better-sqlite3"
import { beforeEach, describe, expect, test } from "vitest"
import {
  backfillSearchIndex,
  fold,
  getContextWindow,
  indexText,
  listConversationsByQuery,
  listScopes,
  resolvePerson,
  resolveScope,
  searchMessages,
  splitReplyQuotes,
  stripHtml,
  toMatchQuery,
} from "./search.ts"
import { migrate, setPrefs, upsertConversations, upsertMessages, upsertUsers } from "./store.ts"

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
  test("anchors keep the full href, not Teams' truncated display text (PSN-104)", () => {
    const href =
      "https://dev.azure.com/FWDGODevOps/Digital_GenAI/_git/genai-distribution-avatar-vite-webview/pullrequest/157145"
    // Teams renders the visible text pre-truncated with its own "…" — the assistant needs the href.
    expect(stripHtml(`see <a href="${href}">https://dev.azure.com/FWDGODev…157145</a> ok`)).toBe(
      `see ${href} ok`,
    )
    // A descriptive label is worth keeping next to the URL.
    expect(stripHtml(`<a href="${href}">the PR</a>`)).toBe(`the PR ${href}`)
    // An href-less anchor still yields its text.
    expect(stripHtml("<a>plain</a>")).toBe("plain")
  })
  test("whitespace collapses", () => {
    expect(stripHtml("<p>a</p><p>b</p>")).toBe("a b")
  })
})

describe("splitReplyQuotes (PSN-104: reply chains)", () => {
  const reply =
    '<blockquote itemtype="http://schema.skype.com/Reply" itemid="1785000000000">' +
    "<strong>Alice</strong><p>can we ship friday?</p></blockquote>" +
    "<p>yes, after QA signs off</p>"

  test("separates the author's own words from what they quoted", () => {
    const { own, quotes } = splitReplyQuotes(reply)
    // The replier said only this — the quoted sentence must NOT be attributed to them.
    expect(own).toBe("yes, after QA signs off")
    expect(quotes).toEqual([
      { msgId: "1785000000000", sender: "Alice", excerpt: "can we ship friday?" },
    ])
  })

  test("a plain message has no quotes and keeps its whole text", () => {
    expect(splitReplyQuotes("<p>just a message</p>")).toEqual({
      own: "just a message",
      quotes: [],
    })
    expect(splitReplyQuotes("")).toEqual({ own: "", quotes: [] })
  })

  test("stacked quotes all resolve; a quote without itemid still carries its text", () => {
    const stacked =
      '<blockquote itemtype="x/Reply" itemid="a"><strong>A</strong>one</blockquote>' +
      '<blockquote itemtype="x/Reply"><strong>B</strong>two</blockquote><p>ok</p>'
    const { own, quotes } = splitReplyQuotes(stacked)
    expect(own).toBe("ok")
    expect(quotes).toEqual([
      { msgId: "a", sender: "A", excerpt: "one" },
      { msgId: undefined, sender: "B", excerpt: "two" },
    ])
  })

  test("a non-reply blockquote is left in the body", () => {
    const { own, quotes } = splitReplyQuotes("<blockquote>quoted prose</blockquote><p>hi</p>")
    expect(own).toBe("quoted prose hi")
    expect(quotes).toEqual([])
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

  test("a reply hit carries its parent, and the snippet is the replier's own words", () => {
    upsertMessages(db, "teams", "c1", [
      {
        id: "m9",
        ts: 9000,
        senderName: "Bob",
        body:
          '<blockquote itemtype="x/Reply" itemid="m3"><strong>Dương</strong>về deploy ngày mai</blockquote>' +
          "<p>đồng ý</p>",
      },
    ])
    const [hit] = searchMessages(db, { query: "dong y" })
    expect(hit.msgId).toBe("m9")
    expect(hit.snippet).toBe("đồng ý")
    expect(hit.quotes).toEqual([{ msgId: "m3", sender: "Dương", excerpt: "về deploy ngày mai" }])
    // The quoted text still MATCHES (the index keeps it) — it just isn't the replier's snippet.
    expect(searchMessages(db, { query: "deploy ngay mai" }).map((h) => h.msgId)).toContain("m9")
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

describe("scopes: the user's folders + labels", () => {
  let db: ReturnType<typeof freshDb>
  beforeEach(() => {
    db = freshDb()
    upsertConversations(db, "teams", [
      { id: "c1", title: "FWD standup" },
      { id: "c2", title: "Guru core" },
      { id: "c3", title: "Random" },
    ])
    upsertMessages(db, "teams", "c1", [{ id: "m1", ts: 1, body: "deploy tonight" }])
    upsertMessages(db, "teams", "c2", [{ id: "m2", ts: 2, body: "deploy blocked" }])
    upsertMessages(db, "teams", "c3", [{ id: "m3", ts: 3, body: "deploy chatter" }])
    setPrefs(db, "teams", "c1", { folder: "Công việc", labels: ["urgent"] })
    setPrefs(db, "teams", "c2", { folder: "Công việc" })
    setPrefs(db, "teams", "c3", { folder: "Personal", labels: ["urgent", "later"] })
  })

  test("listScopes counts every assigned folder and label", () => {
    const s = listScopes(db, "teams")
    expect(s.folders).toEqual([
      { name: "Công việc", count: 2 },
      { name: "Personal", count: 1 },
    ])
    expect(s.labels).toEqual([
      { name: "urgent", count: 2 },
      { name: "later", count: 1 },
    ])
  })

  test("resolveScope is fold-matched (diacritics + casing) and prefers folders", () => {
    expect(resolveScope(db, "teams", "cong viec")).toMatchObject({
      kind: "folder",
      name: "Công việc",
    })
    expect(resolveScope(db, "teams", "cong viec")?.convIds.sort()).toEqual(["c1", "c2"])
    expect(resolveScope(db, "teams", "URGENT")).toMatchObject({ kind: "label", name: "urgent" })
    expect(resolveScope(db, "teams", "nope")).toBeNull()
    expect(resolveScope(db, "teams", "  ")).toBeNull()
  })

  test("an exact match wins over a longer substring match", () => {
    setPrefs(db, "teams", "c3", { labels: ["urgent", "urgent-later"] })
    expect(resolveScope(db, "teams", "urgent")?.name).toBe("urgent")
  })

  test("convIds scopes search and the conversation list; empty means nothing, not everything", () => {
    const scope = resolveScope(db, "teams", "Công việc")
    const ids = scope?.convIds ?? []
    expect(
      searchMessages(db, { query: "deploy", convIds: ids })
        .map((h) => h.msgId)
        .sort(),
    ).toEqual(["m1", "m2"])
    expect(
      listConversationsByQuery(db, "teams", { convIds: ids })
        .map((c) => c.id)
        .sort(),
    ).toEqual(["c1", "c2"])
    expect(searchMessages(db, { query: "deploy", convIds: [] })).toEqual([])
    expect(listConversationsByQuery(db, "teams", { convIds: [] })).toEqual([])
  })
})
