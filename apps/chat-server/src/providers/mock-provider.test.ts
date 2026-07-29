import { beforeEach, describe, expect, test } from "vitest"
import { MockProvider } from "./mock-provider.ts"
import { ProviderError } from "./provider.ts"

describe("MockProvider", () => {
  let p: MockProvider
  beforeEach(() => {
    p = new MockProvider()
  })

  test("lists the seed conversations, service stamped", async () => {
    const { conversations, cursor } = await p.listConversations()
    // The first three are the seeds these tests pin; the rest are the rich local-dev fixtures.
    expect(conversations.slice(0, 3).map((c) => c.id)).toEqual([
      "48:notes",
      "19:oneonone@unq.gbl.spaces",
      "19:group@thread.v2",
    ])
    expect(conversations.every((c) => c.service === "teams")).toBe(true)
    expect(conversations[0].kind).toBe("self")
    expect(cursor).toBeNull()
  })

  test("inject appends an inbound message and raises the version (the sweep's change gate)", async () => {
    const read = async () =>
      (await p.listConversations()).conversations.find((c) => c.id === "19:group@thread.v2")!
    const before = await read()
    const sent = p.inject("19:group@thread.v2", "ping")
    const after = await read()

    expect(after.lastMessageId).toBe(sent.msgId)
    expect(after.lastMessageFromMe).toBe(false)
    expect(after.lastMessagePreview).toBe("ping")
    expect(after.lastMessageVersion).toBeGreaterThan(before.lastMessageVersion)

    const newest = (await p.fetchHistory("19:group@thread.v2")).messages.at(-1)!
    expect(newest.id).toBe(sent.msgId)
    expect(newest.self).toBeUndefined()
  })

  test("history pages newest-first and chains the cursor to the end", async () => {
    const first = await p.fetchHistory("19:group@thread.v2")
    expect(first.messages.map((m) => m.id)).toEqual(["3003", "3004"])
    expect(first.cursor).toBe("2")

    const second = await p.fetchHistory("19:group@thread.v2", first.cursor)
    expect(second.messages.map((m) => m.id)).toEqual(["3001", "3002"])
    expect(second.cursor).toBeNull()
  })

  test("sendReply appends a self message and advances last-message", async () => {
    const r = await p.sendReply("19:oneonone@unq.gbl.spaces", "yo")
    expect(r.ok).toBe(true)
    expect(r.clientMessageId).toMatch(/^cmid-/)

    const page = await p.fetchHistory("19:oneonone@unq.gbl.spaces")
    const last = page.messages.at(-1)!
    expect(last.id).toBe(r.ts)
    expect(last.self).toBe(true)
    expect(last.body).toBe("yo")

    const convs = await p.listConversations()
    const conv = convs.conversations.find((c) => c.id === "19:oneonone@unq.gbl.spaces")!
    expect(conv.lastMessageId).toBe(r.ts)
    expect(conv.lastMessageFromMe).toBe(true)
  })

  test("react toggles the viewer's reaction on and off", async () => {
    await p.react("19:group@thread.v2", "3001", "like", false)
    let msg = (await p.fetchHistory("19:group@thread.v2", "2")).messages.find(
      (m) => m.id === "3001",
    )!
    expect(msg.reactions).toEqual([{ key: "like", emoji: "🙂", count: 1, mine: true }])

    await p.react("19:group@thread.v2", "3001", "like", true)
    msg = (await p.fetchHistory("19:group@thread.v2", "2")).messages.find((m) => m.id === "3001")!
    expect(msg.reactions).toBeUndefined()
  })

  test("edit and delete mutate the target message", async () => {
    await p.edit("48:notes", "1000", "edited")
    let msg = (await p.fetchHistory("48:notes")).messages[0]
    expect(msg.body).toBe("edited")
    expect(msg.edited).toBe(true)

    await p.delete("48:notes", "1000")
    msg = (await p.fetchHistory("48:notes")).messages[0]
    expect(msg.deleted).toBe(true)
    expect(msg.body).toBe("")
  })

  test("roster stamps id + self; avatar miss is honored", async () => {
    const members = await p.roster("19:oneonone@unq.gbl.spaces")
    expect(members).toContainEqual({ id: "8:orgid:self-oid", name: "You", self: true })
    expect(await p.avatar("no-photo-oid")).toEqual({ miss: true })
  })

  test("unknown conversation throws a typed ProviderError", async () => {
    await expect(p.fetchHistory("nope")).rejects.toBeInstanceOf(ProviderError)
    await expect(p.fetchHistory("nope")).rejects.toMatchObject({ code: "not_found", status: 404 })
  })

  describe("searchMessages", () => {
    test("returns fixture hits whose preview matches the query (case-insensitive)", async () => {
      const page = await p.searchMessages("deploy")
      expect(page.cursor).toBeNull()
      // Three fixtures mention "deploy" — one hydrated (group), two not (lost/archive).
      expect(page.total).toBe(3)
      expect(page.rows.map((h) => h.msgId).sort()).toEqual(["3002", "9001", "9002"])
    })

    test("includes hits the local DB has never seeded — the substrate gap the epic closes", async () => {
      const page = await p.searchMessages("rollback")
      expect(page.total).toBe(1)
      const [hit] = page.rows
      expect(hit.convId).toBe("19:lost@thread.tacv2") // not in seed()
      expect(hit.msgId).toBe("9001")
      expect(hit.itemClass).toBe("IPM.SkypeTeams.Message")
    })

    test("returns no rows for an empty/whitespace query", async () => {
      expect(await p.searchMessages("")).toEqual({ rows: [], cursor: null, total: 0 })
      expect(await p.searchMessages("   ")).toEqual({ rows: [], cursor: null, total: 0 })
    })

    test("accepts sort/cursor opts without changing the result (single page per call)", async () => {
      const a = await p.searchMessages("deploy", { sort: "recent", cursor: null })
      const b = await p.searchMessages("deploy", { sort: "relevance", cursor: "0" })
      expect(a.total).toBe(b.total)
      expect(a.rows.map((h) => h.msgId).sort()).toEqual(b.rows.map((h) => h.msgId).sort())
    })
  })
})
