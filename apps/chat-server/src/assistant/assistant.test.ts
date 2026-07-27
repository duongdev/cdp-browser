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
      contextRefs: [{ service: "teams", convId: "c1", title: "T", deepLink: "/chat/c/c1" }],
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

  test("context attach injects excerpt + pins ref", async () => {
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
    expect(session?.contextRefs[0].deepLink).toBe("/chat/c/c1?msg=m2")
    const msgs = loadMessages(db, s.id)
    expect(msgs).toHaveLength(1)
    expect((msgs[0].parts[0] as { text: string }).text).toContain("deploy is done")
  })
})

describe("stripReasoningRemnants", () => {
  test("drops stray think tags, keeps everything else", () => {
    expect(stripReasoningRemnants("answer [msg:c:m].</think>")).toBe("answer [msg:c:m].")
    expect(stripReasoningRemnants("<think>hidden</think>visible")).toBe("hiddenvisible")
    expect(stripReasoningRemnants("plain")).toBe("plain")
  })
})
