import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test"
import Database from "better-sqlite3"
import { beforeEach, describe, expect, test, vi } from "vitest"
import { migrate, upsertMessages, upsertUsers } from "../store.ts"
import {
  citationKey,
  collectIds,
  stripReasoningRemnants,
  surfacedIdsFromMessages,
  validateCitations,
} from "./citations.ts"
import { KEEP_RECENT_MESSAGES, planCompaction } from "./compact.ts"
import { buildSystemPrompt } from "./loop.ts"
import { createAssistantRoutes } from "./routes.ts"
import {
  appendMessage,
  createSession,
  deleteSession,
  getSession,
  listSessions,
  loadMessages,
  SDK_MAJOR,
  sanitizePartsForModel,
  updateSession,
} from "./session-store.ts"

function freshDb() {
  const db = new Database(":memory:")
  migrate(db)
  return db
}

describe("session store", () => {
  let db: Database.Database
  beforeEach(() => {
    db = freshDb()
  })

  test("CRUD round-trip", () => {
    const s = createSession(db, { title: null, model: "glm/glm-4.7" })
    expect(getSession(db, s.id)?.model).toBe("glm/glm-4.7")
    updateSession(db, s.id, { title: "Deploy talk" })
    expect(getSession(db, s.id)?.title).toBe("Deploy talk")
    expect(listSessions(db).map((x) => x.id)).toContain(s.id)
    deleteSession(db, s.id)
    expect(getSession(db, s.id)).toBeNull()
  })

  test("UIMessage persist/load, sdk_major stamped, idx ordered", () => {
    const s = createSession(db)
    appendMessage(db, s.id, { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] })
    appendMessage(db, s.id, {
      id: "a1",
      role: "assistant",
      parts: [{ type: "text", text: "hello" }],
      metadata: { citations: [] },
    })
    const msgs = loadMessages(db, s.id)
    expect(msgs.map((m) => m.id)).toEqual(["u1", "a1"])
    const row = db
      .prepare("SELECT sdk_major FROM ai_messages WHERE session_id = ? AND id = 'a1'")
      .get(s.id) as { sdk_major: number }
    expect(row.sdk_major).toBe(SDK_MAJOR)
  })

  test("same message id re-append replaces in place", () => {
    const s = createSession(db)
    appendMessage(db, s.id, { id: "a1", role: "assistant", parts: [{ type: "text", text: "v1" }] })
    appendMessage(db, s.id, { id: "a1", role: "assistant", parts: [{ type: "text", text: "v2" }] })
    const msgs = loadMessages(db, s.id)
    expect(msgs).toHaveLength(1)
    expect((msgs[0].parts[0] as { text: string }).text).toBe("v2")
  })

  test("tolerant load: junk parts JSON drops the row, never throws", () => {
    const s = createSession(db)
    appendMessage(db, s.id, { id: "u1", role: "user", parts: [{ type: "text", text: "ok" }] })
    db.prepare(
      "INSERT INTO ai_messages (id, session_id, idx, role, parts) VALUES ('bad', ?, 99, 'user', '{not json')",
    ).run(s.id)
    const msgs = loadMessages(db, s.id)
    expect(msgs.map((m) => m.id)).toEqual(["u1"])
  })

  test("context refs survive round-trip; poisoned JSON degrades to []", () => {
    const s = createSession(db)
    updateSession(db, s.id, {
      contextRefs: [
        { service: "teams", kind: "chat", convId: "c1", title: "T", deepLink: "/chat/c/c1" },
      ],
    })
    expect(getSession(db, s.id)?.contextRefs).toHaveLength(1)
    db.prepare("UPDATE ai_sessions SET context_refs = 'garbage' WHERE id = ?").run(s.id)
    expect(getSession(db, s.id)?.contextRefs).toEqual([])
  })

  test("sanitizePartsForModel keeps model-safe + tool parts, drops junk", () => {
    const parts = [
      { type: "text", text: "a" },
      { type: "tool-search_messages", output: [] },
      { type: "dynamic-tool" },
      { type: "future-widget" },
      { noType: true },
    ]
    expect(sanitizePartsForModel(parts).map((p) => (p as { type: string }).type)).toEqual([
      "text",
      "tool-search_messages",
      "dynamic-tool",
    ])
  })
})

describe("citations", () => {
  test("valid kept, hallucinated stripped, malformed degrades", () => {
    const surfaced = new Set([citationKey({ convId: "19:abc@thread", msgId: "m100" })])
    const { text, citations } = validateCitations(
      "Real [msg:19:abc@thread:m100] fake [msg:19:abc@thread:m999] broken [msg:nocolon]",
      surfaced,
    )
    expect(text).toBe("Real [msg:19:abc@thread:m100] fake  broken ")
    expect(citations).toEqual([{ convId: "19:abc@thread", msgId: "m100" }])
  })

  test("convId with colons splits on last colon", () => {
    const surfaced = new Set([
      citationKey({ convId: "19:x_y@unq.gbl.spaces", msgId: "1721990000000" }),
    ])
    const r = validateCitations("[msg:19:x_y@unq.gbl.spaces:1721990000000]", surfaced)
    expect(r.citations).toEqual([{ convId: "19:x_y@unq.gbl.spaces", msgId: "1721990000000" }])
  })

  test("dedupes repeated markers", () => {
    const surfaced = new Set([citationKey({ convId: "c1", msgId: "m1" })])
    const r = validateCitations("[msg:c1:m1] again [msg:c1:m1]", surfaced)
    expect(r.citations).toHaveLength(1)
  })

  test("surfacedIdsFromMessages scans tool output parts", () => {
    const set = surfacedIdsFromMessages([
      {
        parts: [
          { type: "text", text: "x" },
          { type: "tool-search_messages", output: [{ convId: "c1", msgId: "m1" }] },
        ],
      },
    ])
    expect(set.has(citationKey({ convId: "c1", msgId: "m1" }))).toBe(true)
  })

  test("collectIds bounds depth", () => {
    const set = new Set<string>()
    const deep = { a: { b: { c: { d: { e: { convId: "c", msgId: "m" } } } } } }
    collectIds(deep, set)
    expect(set.size).toBe(0)
  })
})

describe("compaction policy", () => {
  const msg = (chars: number, i: number) => ({
    id: `m${i}`,
    role: "user" as const,
    parts: [{ type: "text", text: "x".repeat(chars) }],
  })

  test("below threshold → not needed", () => {
    const plan = planCompaction([msg(100, 0), msg(100, 1)], 0, null)
    expect(plan.needed).toBe(false)
  })

  test("over threshold → watermark advances, keeps recent", () => {
    const messages = Array.from({ length: 20 }, (_, i) => msg(20_000, i))
    const plan = planCompaction(messages, 0, null)
    expect(plan.needed).toBe(true)
    expect(plan.uptoIdx).toBe(20 - KEEP_RECENT_MESSAGES)
    expect(plan.fromIdx).toBe(0)
  })

  test("already-summarized part doesn't count; watermark never rewinds", () => {
    const messages = Array.from({ length: 20 }, (_, i) => msg(20_000, i))
    const plan = planCompaction(messages, 15, null)
    expect(plan.needed).toBe(false)
  })
})

// ---- agent loop + route with a mock model ----------------------------------

function toolCallModel() {
  // Step 1: call search_messages; step 2: answer with a citation marker.
  let call = 0
  return new MockLanguageModelV3({
    doStream: async () => {
      call++
      const usage = {
        inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 20, text: 20, reasoning: undefined },
        raw: undefined,
      }
      if (call === 1) {
        return {
          stream: convertArrayToReadableStream([
            { type: "stream-start", warnings: [] },
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "search_messages",
              input: JSON.stringify({ query: "deploy" }),
            },
            { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
          ]),
        }
      }
      return {
        stream: convertArrayToReadableStream([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t1" },
          {
            type: "text-delta",
            id: "t1",
            delta: "Bob said deploy is done [msg:c1:m2] and fake [msg:c1:zzz].",
          },
          { type: "text-end", id: "t1" },
          { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
        ]),
      }
    },
  })
}

describe("chat route (mock model)", () => {
  let db: Database.Database
  beforeEach(() => {
    db = freshDb()
    upsertMessages(db, "teams", "c1", [
      { id: "m2", ts: 2000, senderId: "u2", senderName: "Bob", body: "deploy is done" },
    ])
    upsertUsers(db, "teams", [{ id: "u2", displayName: "Bob" }])
  })

  test("tool round-trip, step cap, onEnd persistence, citation validation", async () => {
    const app = createAssistantRoutes({ db, getModel: () => toolCallModel() })
    const session = createSession(db)
    const res = await app.request(`/${session.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [
          { id: "u1", role: "user", parts: [{ type: "text", text: "what about the deploy?" }] },
        ],
      }),
    })
    expect(res.status).toBe(200)
    await res.text() // drain the stream
    await vi.waitFor(() => {
      const msgs = loadMessages(db, session.id)
      expect(msgs.some((m) => m.role === "assistant")).toBe(true)
    })
    const msgs = loadMessages(db, session.id)
    expect(msgs[0].id).toBe("u1")
    const assistant = msgs.find((m) => m.role === "assistant") as {
      parts: { type: string; text?: string }[]
      metadata?: { citations?: unknown[] }
    }
    const text = assistant.parts
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("")
    expect(text).toContain("[msg:c1:m2]")
    expect(text).not.toContain("zzz")
    expect(assistant.metadata?.citations).toEqual([{ convId: "c1", msgId: "m2" }])
    // usage accumulated
    await vi.waitFor(() => {
      expect(getSession(db, session.id)?.totalTokens).toBeGreaterThan(0)
    })
  })

  test("unknown session → 404; unconfigured llm → typed 503", async () => {
    const app404 = createAssistantRoutes({ db, getModel: () => toolCallModel() })
    const r1 = await app404.request("/nope", { method: "POST", body: "{}" })
    expect(r1.status).toBe(404)

    const appUnconf = createAssistantRoutes({ db }) // env unset in tests
    const s = createSession(db)
    const r2 = await appUnconf.request(`/${s.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    })
    expect(r2.status).toBe(503)
    expect(((await r2.json()) as { error: string }).error).toBe("llm-unconfigured")
  })

  test("session CRUD routes", async () => {
    const app = createAssistantRoutes({ db, getModel: () => toolCallModel() })
    const created = (await (
      await app.request("/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "glm/glm-4.7" }),
      })
    ).json()) as { session: { id: string } }
    const list = (await (await app.request("/sessions")).json()) as { sessions: unknown[] }
    expect(list.sessions).toHaveLength(1)
    const patched = (await (
      await app.request(`/sessions/${created.session.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Renamed" }),
      })
    ).json()) as { session: { title: string } }
    expect(patched.session.title).toBe("Renamed")
    await app.request(`/sessions/${created.session.id}`, { method: "DELETE" })
    const after = (await (await app.request("/sessions")).json()) as { sessions: unknown[] }
    expect(after.sessions).toHaveLength(0)
  })

  test("context attach pins a ref and writes NOTHING to the transcript (grill)", async () => {
    const app = createAssistantRoutes({ db, getModel: () => toolCallModel() })
    const s = createSession(db)
    const r = await app.request(`/sessions/${s.id}/context`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ convId: "c1", msgId: "m2", title: "Bob chat" }),
    })
    expect(r.status).toBe(200)
    const session = getSession(db, s.id)
    expect(session?.contextRefs).toHaveLength(1)
    expect(session?.contextRefs[0]).toMatchObject({ kind: "message", msgId: "m2" })
    expect(session?.contextRefs[0].deepLink).toBe("/chat/c/c1?msg=m2")
    // The old build injected an excerpt message here; a ref is now pure.
    expect(loadMessages(db, s.id)).toHaveLength(0)
  })
})

describe("stripReasoningRemnants", () => {
  test("drops stray think tags, keeps everything else", () => {
    expect(stripReasoningRemnants("answer [msg:c:m].</think>")).toBe("answer [msg:c:m].")
    expect(stripReasoningRemnants("<think>hidden</think>visible")).toBe("hiddenvisible")
    expect(stripReasoningRemnants("plain")).toBe("plain")
  })
})

describe("buildSystemPrompt scope", () => {
  test("no attachments → no scope line at all (grill: empty tray searches everything)", () => {
    const p = buildSystemPrompt({})
    expect(p).not.toMatch(/currently viewing/i)
    expect(p).not.toMatch(/attached/i)
  })
})

describe("buildSystemPrompt response style (PSN-104 steering: caveman + i-have-adhd)", () => {
  const p = buildSystemPrompt({})

  test("carries the terse, action-first rules on every turn", () => {
    expect(p).toMatch(/Lead with the answer or the next action/)
    expect(p).toMatch(/No preamble/)
    expect(p).toMatch(/numbered list/)
    expect(p).toMatch(/five items max/i)
    expect(p).toMatch(/ONE concrete next action/)
  })

  test("compression never eats facts, quotes, or a reply meant for someone else", () => {
    // The carve-outs are what stop terse-mode leaking into a colleague's inbox.
    expect(p).toMatch(/this is compression, not omission/)
    expect(p).toMatch(/NEVER compress/)
    expect(p).toMatch(/quoted from a real message/)
    expect(p).toMatch(/meant for someone else/)
    expect(p).toMatch(/irreversible/)
  })

  test("carries the CLAUDE.md rules the coding agents follow", () => {
    expect(p).toMatch(/Bad news first/)
    expect(p).toMatch(/No emoji/)
    expect(p).toMatch(/rank them and say which you'd pick/)
  })

  test("language mirroring survives the style block", () => {
    expect(p).toMatch(/mirror Vietnamese with Vietnamese/)
  })
})

describe("multi-turn persistence (steering: wrong order / lost replies)", () => {
  test("each turn appends its own assistant row — replies never overwrite each other", async () => {
    const db = freshDb()
    upsertMessages(db, "teams", "c1", [
      { id: "m2", ts: 2000, senderId: "u2", senderName: "Bob", body: "deploy is done" },
    ])
    const app = createAssistantRoutes({ db, getModel: () => toolCallModel() })
    const session = createSession(db)
    for (const [i, text] of ["first", "second", "third"].entries()) {
      const res = await app.request(`/${session.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: [{ id: `u${i}`, role: "user", parts: [{ type: "text", text }] }],
        }),
      })
      await res.text()
      await vi.waitFor(() => {
        expect(loadMessages(db, session.id).filter((m) => m.role === "assistant")).toHaveLength(
          i + 1,
        )
      })
    }
    const roles = loadMessages(db, session.id).map((m) => m.role)
    expect(roles).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"])
    const ids = loadMessages(db, session.id)
      .filter((m) => m.role === "assistant")
      .map((m) => m.id)
    expect(new Set(ids).size).toBe(3)
  })
})

describe("context refs (grill: the attach tray)", () => {
  let db: Database.Database
  let app: ReturnType<typeof createAssistantRoutes>
  beforeEach(() => {
    db = freshDb()
    upsertMessages(db, "teams", "c1", [{ id: "m1", ts: 1000, senderName: "Bob", body: "hello" }])
    app = createAssistantRoutes({ db, getModel: () => toolCallModel() })
  })

  const attach = (id: string, b: object) =>
    app.request(`/sessions/${id}/context`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(b),
    })

  test("attaching writes NO transcript message — the tray is the only record", async () => {
    const s = createSession(db)
    await attach(s.id, { convId: "c1", title: "Deploy crew" })
    expect(loadMessages(db, s.id)).toHaveLength(0)
    expect(getSession(db, s.id)?.contextRefs).toEqual([
      expect.objectContaining({ kind: "chat", convId: "c1", title: "Deploy crew" }),
    ])
  })

  test("chat vs message refs coexist; the same target can't be attached twice", async () => {
    const s = createSession(db)
    await attach(s.id, { convId: "c1", title: "Deploy crew" })
    await attach(s.id, { convId: "c1", title: "Deploy crew" })
    await attach(s.id, {
      convId: "c1",
      msgId: "m1",
      title: "Deploy crew",
      sender: "Bob",
      preview: "hello",
    })
    const refs = getSession(db, s.id)?.contextRefs ?? []
    expect(refs).toHaveLength(2)
    expect(refs.map((r) => r.kind)).toEqual(["chat", "message"])
    expect(refs[1]).toMatchObject({ sender: "Bob", preview: "hello" })
  })

  test("detach removes exactly one target", async () => {
    const s = createSession(db)
    await attach(s.id, { convId: "c1", title: "Deploy crew" })
    await attach(s.id, { convId: "c1", msgId: "m1", title: "Deploy crew" })
    const res = await app.request(`/sessions/${s.id}/context?convId=c1&msgId=m1`, {
      method: "DELETE",
    })
    expect(res.status).toBe(200)
    const refs = getSession(db, s.id)?.contextRefs ?? []
    expect(refs).toHaveLength(1)
    expect(refs[0].kind).toBe("chat")
    expect(refs[0].msgId).toBeUndefined()
  })

  test("system prompt lists refs as read-first, soft-bias — no hidden scope line", () => {
    const p = buildSystemPrompt({
      contextRefs: [
        { service: "teams", kind: "chat", convId: "c1", title: "Deploy crew", deepLink: "/x" },
        {
          service: "teams",
          kind: "message",
          convId: "c1",
          msgId: "m1",
          title: "Deploy crew",
          sender: "Bob",
          deepLink: "/x",
        },
      ],
    })
    expect(p).toMatch(/Read them first/)
    expect(p).toMatch(/only search wider when the question clearly calls for it/)
    expect(p).toContain('the whole conversation "Deploy crew" (convId c1)')
    expect(p).toContain('message from Bob in "Deploy crew" (convId c1, msgId m1)')
    expect(p).not.toMatch(/currently viewing/i)
  })

  test("a folder/label attaches as a live SCOPE — name, no ids (PSN-104)", async () => {
    const s = createSession(db)
    await attach(s.id, { kind: "folder", name: "Công việc" })
    await attach(s.id, { kind: "folder", name: "Công việc" }) // duplicate ignored
    await attach(s.id, { kind: "label", name: "urgent" })
    const refs = getSession(db, s.id)?.contextRefs ?? []
    expect(refs.map((r) => r.kind)).toEqual(["folder", "label"])
    expect(refs[0]).toMatchObject({ name: "Công việc", title: "Công việc" })
    expect(refs[0].convId).toBeUndefined()
    // A nameless scope is rejected, not stored as an empty chip.
    expect((await attach(s.id, { kind: "folder", name: "  " })).status).toBe(400)
  })

  test("a scope detaches by (kind, name) and leaves conversation refs alone", async () => {
    const s = createSession(db)
    await attach(s.id, { convId: "c1", title: "Deploy crew" })
    await attach(s.id, { kind: "folder", name: "Work" })
    const res = await app.request(`/sessions/${s.id}/context?kind=folder&name=Work`, {
      method: "DELETE",
    })
    expect(res.status).toBe(200)
    const refs = getSession(db, s.id)?.contextRefs ?? []
    expect(refs.map((r) => r.kind)).toEqual(["chat"])
  })

  test("the prompt sends the model to resolve_scope for an attached folder", () => {
    const p = buildSystemPrompt({
      contextRefs: [
        { service: "teams", kind: "folder", name: "FWD", title: "FWD", deepLink: "" },
        { service: "teams", kind: "label", name: "urgent", title: "urgent", deepLink: "" },
      ],
    })
    expect(p).toContain('everything in the folder "FWD"')
    expect(p).toContain('everything in the label "urgent"')
    expect(p).toMatch(/resolve_scope/)
  })
})

describe("load order (steering: order wrong on refresh / session load)", () => {
  test("idx ordering survives out-of-order ids, gaps and a reload", () => {
    const db = freshDb()
    const s = createSession(db)
    // ids that sort differently as STRINGS than they do chronologically — if anything ever ordered
    // by id (or by created_at, which collides at ms resolution), this is what breaks.
    appendMessage(db, s.id, { id: "z-user-1", role: "user", parts: [{ type: "text", text: "1" }] })
    appendMessage(db, s.id, {
      id: "a-ai-1",
      role: "assistant",
      parts: [{ type: "text", text: "2" }],
    })
    appendMessage(db, s.id, { id: "y-user-2", role: "user", parts: [{ type: "text", text: "3" }] })
    appendMessage(db, s.id, {
      id: "b-ai-2",
      role: "assistant",
      parts: [{ type: "text", text: "4" }],
    })
    const texts = () => loadMessages(db, s.id).map((m) => (m.parts[0] as { text: string }).text)
    expect(texts()).toEqual(["1", "2", "3", "4"])

    // A dropped row (tolerant load) leaves an idx gap — order of the survivors must hold.
    db.prepare("DELETE FROM ai_messages WHERE session_id = ? AND idx = 1").run(s.id)
    expect(texts()).toEqual(["1", "3", "4"])

    // A later append must land after the highest idx, never re-use the freed one.
    appendMessage(db, s.id, {
      id: "c-ai-3",
      role: "assistant",
      parts: [{ type: "text", text: "5" }],
    })
    expect(texts()).toEqual(["1", "3", "4", "5"])
  })

  test("same-millisecond appends keep insertion order", () => {
    const db = freshDb()
    const s = createSession(db)
    const now = 1_700_000_000_000
    for (const [i, t] of ["a", "b", "c", "d"].entries()) {
      appendMessage(
        db,
        s.id,
        { id: `m${i}`, role: "user", parts: [{ type: "text", text: t }] },
        now,
      )
    }
    expect(loadMessages(db, s.id).map((m) => (m.parts[0] as { text: string }).text)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ])
  })
})

/**
 * Recording route (t179). When a turn runs on the Hermes agent, chat-server's own turn route
 * never executes — so nothing persisted the exchange, named the session or compacted it.
 * Measured on preview before this existed: two turns left 0 rows and title=null, meaning a
 * panel reload showed an empty thread while Hermes still held the history.
 */
describe("proxy-recorded messages", () => {
  let db: Database.Database
  beforeEach(() => {
    db = freshDb()
  })

  test("records a message the panel can read back", async () => {
    const app = createAssistantRoutes({ db, getModel: () => toolCallModel() })
    const session = createSession(db, { title: null, model: null })

    const res = await app.request(`/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: { id: "u-1", role: "user", parts: [{ type: "text", text: "hello" }] },
      }),
    })

    expect(res.status).toBe(200)
    const stored = loadMessages(db, session.id)
    expect(stored).toHaveLength(1)
    expect(stored[0].role).toBe("user")
  })

  test("dedups on message id so a retry does not duplicate the turn", async () => {
    const app = createAssistantRoutes({ db, getModel: () => toolCallModel() })
    const session = createSession(db, { title: null, model: null })
    const body = JSON.stringify({
      message: { id: "u-1", role: "user", parts: [{ type: "text", text: "hello" }] },
    })

    await app.request(`/sessions/${session.id}/messages`, { method: "POST", body })
    await app.request(`/sessions/${session.id}/messages`, { method: "POST", body })

    expect(loadMessages(db, session.id)).toHaveLength(1)
  })

  test("accepts a system marker row", async () => {
    // The model-change marker is a system row. Rejecting it would leave the model switch
    // invisible in the thread, which is exactly what Dustin asked to be able to see.
    const app = createAssistantRoutes({ db, getModel: () => toolCallModel() })
    const session = createSession(db, { title: null, model: null })

    const res = await app.request(`/sessions/${session.id}/messages`, {
      method: "POST",
      body: JSON.stringify({
        message: {
          id: "sys-1",
          role: "system",
          parts: [{ type: "text", text: "Model changed to glm/glm-5.1" }],
          metadata: { kind: "model-change", from: null, to: "glm/glm-5.1" },
        },
      }),
    })

    expect(res.status).toBe(200)
    expect(loadMessages(db, session.id)[0].role).toBe("system")
  })

  test("rejects a malformed message instead of storing it", async () => {
    // A bad row here is permanent: it lands in history and breaks every future reload of the
    // thread. Failing the write is recoverable; storing garbage is not.
    const app = createAssistantRoutes({ db, getModel: () => toolCallModel() })
    const session = createSession(db, { title: null, model: null })
    const post = (message: unknown) =>
      app.request(`/sessions/${session.id}/messages`, {
        method: "POST",
        body: JSON.stringify({ message }),
      })

    expect((await post({ role: "user", parts: [] })).status).toBe(400)
    expect((await post({ id: "x", role: "tool", parts: [] })).status).toBe(400)
    expect((await post({ id: "x", role: "user", parts: "nope" })).status).toBe(400)
    expect(loadMessages(db, session.id)).toHaveLength(0)
  })

  test("rejects an oversized body", async () => {
    const app = createAssistantRoutes({ db, getModel: () => toolCallModel() })
    const session = createSession(db, { title: null, model: null })

    const res = await app.request(`/sessions/${session.id}/messages`, {
      method: "POST",
      body: JSON.stringify({
        message: {
          id: "big",
          role: "assistant",
          parts: [{ type: "text", text: "x".repeat(300_000) }],
        },
      }),
    })

    expect(res.status).toBe(413)
    expect(loadMessages(db, session.id)).toHaveLength(0)
  })

  test("404s for an unknown session", async () => {
    const app = createAssistantRoutes({ db, getModel: () => toolCallModel() })
    const res = await app.request("/sessions/nope/messages", {
      method: "POST",
      body: JSON.stringify({ message: { id: "m", role: "user", parts: [] } }),
    })
    expect(res.status).toBe(404)
  })

  test("names the session only when maintain is set", async () => {
    // Title generation is the side effect the Hermes path lost. Without `maintain` it must not
    // fire on the opening user write, or the session gets named from half an exchange.
    const app = createAssistantRoutes({ db, getModel: () => toolCallModel() })
    const session = createSession(db, { title: null, model: null })

    await app.request(`/sessions/${session.id}/messages`, {
      method: "POST",
      body: JSON.stringify({
        message: { id: "u-1", role: "user", parts: [{ type: "text", text: "deploy question" }] },
      }),
    })
    expect(getSession(db, session.id)?.title).toBeNull()

    await app.request(`/sessions/${session.id}/messages`, {
      method: "POST",
      body: JSON.stringify({
        maintain: true,
        message: { id: "a-1", role: "assistant", parts: [{ type: "text", text: "an answer" }] },
      }),
    })
    await vi.waitFor(() => expect(getSession(db, session.id)?.title).toBeTruthy())
  })
})

/** Marker rows are stored and rendered but must never be sent to the model — they are notes
 *  for the user, and a model reading one would treat it as an instruction it was given. */
describe("marker rows stay out of the model transcript", () => {
  test("a stored system row never reaches the model", async () => {
    const db = freshDb()
    const seen: unknown[] = []
    // Capture what the turn route actually hands the model, rather than re-testing the filter
    // expression — a test that restates the implementation passes even when the wiring is wrong.
    const spyModel = () =>
      new MockLanguageModelV3({
        doStream: async ({ prompt }) => {
          seen.push(...prompt)
          return {
            stream: convertArrayToReadableStream([
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "t1" },
              { type: "text-delta", id: "t1", delta: "ok" },
              { type: "text-end", id: "t1" },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: undefined },
                usage: {
                  inputTokens: {
                    total: 1,
                    noCache: 1,
                    cacheRead: undefined,
                    cacheWrite: undefined,
                  },
                  outputTokens: { total: 1, text: 1, reasoning: undefined },
                  raw: undefined,
                },
              },
            ]),
          }
        },
      })

    const app = createAssistantRoutes({ db, getModel: spyModel })
    const session = createSession(db, { title: "t", model: null })
    appendMessage(db, session.id, {
      id: "sys-1",
      role: "system",
      parts: [{ type: "text", text: "Model changed to glm/glm-5.1" }],
      metadata: { kind: "model-change" },
    })

    const res = await app.request(`/${session.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: { id: "u-1", role: "user", parts: [{ type: "text", text: "hi" }] },
      }),
    })
    await res.text()

    // Both halves matter. Without the first, this passes vacuously: a system row reaching
    // `convertToModelMessages` throws AI_InvalidPromptError, the model is never called, and
    // "the transcript does not contain the marker" is trivially true of an empty transcript.
    // That is how the reverted filter survived the first mutation run.
    expect(seen.length).toBeGreaterThan(0)
    expect(JSON.stringify(seen)).not.toContain("Model changed to")
  })
})
