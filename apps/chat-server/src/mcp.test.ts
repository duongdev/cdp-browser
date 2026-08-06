// MCP server tests (PSN-114; write tools ADR-0026). L1: the pure Origin gate. L3: a real MCP client
// over a real HTTP server (ephemeral port, :memory: db + mock fixtures) exercising the tool surface —
// the regression backbone per the plan. The tools themselves are thin wrappers over already-tested
// pure fns (search.test.ts / unread-overview.test.ts), so this covers wiring + dispatch + the wire
// contract, not retrieval correctness.

import { serve } from "@hono/node-server"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import Database from "better-sqlite3"
import { Hono } from "hono"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest"
import type { HydrateEngine } from "./hydrate.ts"
import { mountMcp, originAllowed } from "./mcp.ts"
import type { ChatProvider, ProviderSearchHit, ProviderSearchPage } from "./providers/provider.ts"
import {
  getReadState,
  markConversationRead,
  markConversationUnread,
  migrate,
  upsertConversations,
  upsertMessages,
  upsertUsers,
} from "./store.ts"

const WRITE_TOOLS = [
  "send_reply",
  "react_to_message",
  "edit_message",
  "delete_message",
  "mark_read",
  "mark_unread",
]

function freshDb() {
  const db = new Database(":memory:")
  migrate(db)
  return db
}

function seed(db: Database.Database) {
  upsertConversations(db, "teams", [
    {
      id: "c1",
      kind: "group",
      title: "Deploy talk",
      lastMessageId: "m1",
      lastMessageVersion: 1,
      lastMessageTs: 1000,
      lastMessagePreview: "deploy is go",
      lastMessageFromMe: false,
    },
  ])
  upsertMessages(db, "teams", "c1", [
    { id: "m1", ts: 1000, senderName: "Bob", body: "deploy is go for tomorrow" },
    {
      id: "m2",
      ts: 2000,
      senderName: "Anh",
      body: "<p>confirmed, see <a href='https://x/y'>plan</a></p>",
    },
  ])
  upsertUsers(db, "teams", [
    { id: "u-bob", displayName: "Bob Zhang" },
    { id: "u-anh", displayName: "Anh Tran" },
  ])
}

// A substrate hit NOT in the local db — exercises the PSN-115 fallback path through the MCP tool.
const SUBSTRATE_HIT: ProviderSearchHit = {
  convId: "c2",
  msgId: "m9",
  preview: "standup notes from tuesday",
  sender: "Carol",
  ts: 5000,
  subject: "",
}

function fakeSearch(): { provider: ChatProvider; hydrate: HydrateEngine } {
  const provider = {
    async searchMessages(query: string): Promise<ProviderSearchPage> {
      const q = query.trim().toLowerCase()
      const rows = [SUBSTRATE_HIT].filter((h) => h.preview.toLowerCase().includes(q))
      return { rows, cursor: null, total: rows.length }
    },
  } as Pick<ChatProvider, "searchMessages">
  const hydrate = {
    // No-op: leave the substrate row un-hydrated so it ships as substrate:true.
    async hydrateHits() {
      return []
    },
  } as Pick<HydrateEngine, "hydrateHits">
  return { provider: provider as ChatProvider, hydrate: hydrate as HydrateEngine }
}

describe("originAllowed (L1, pure)", () => {
  // The real gate, imported — not a re-implementation. A copy here would stay green while mcp.ts
  // regressed, which is exactly how the prefix-match bypass below survived review once.
  const allowed = originAllowed
  test("absent origin (non-browser client) allowed", () => expect(allowed(undefined)).toBe(true))
  test("localhost allowed", () => expect(allowed("http://localhost:5173")).toBe(true))
  test("127.0.0.1 allowed", () => expect(allowed("http://127.0.0.1:7810")).toBe(true))
  test("IPv6 loopback allowed", () => expect(allowed("http://[::1]:7810")).toBe(true))
  test("cross-origin rejected (DNS rebinding)", () =>
    expect(allowed("https://evil.example")).toBe(false))

  // A prefix match on the whole Origin string lets an attacker register a domain that merely starts
  // with an allowed one. Since ADR-0025 proxies /mcp onto the tailnet and ADR-0026 added write
  // tools, passing this gate means send/edit/delete on the operator's real Teams account.
  test.each([
    "http://localhost.evil.com",
    "http://127.0.0.1.evil.com",
    "http://localhost-attacker.net",
    "http://[::1].evil.com",
  ])("look-alike host rejected: %s", (o) => expect(allowed(o)).toBe(false))

  test("https loopback rejected (page must be served over http like the app is)", () =>
    expect(allowed("https://localhost")).toBe(false))
  test("non-http scheme rejected", () => expect(allowed("file://")).toBe(false))
  test("unparseable origin rejected", () => expect(allowed("not a url")).toBe(false))
})

describe("MCP server over HTTP (L3, real client)", () => {
  let server: ReturnType<typeof serve>
  let url: string
  let client: Client

  beforeAll(async () => {
    const db = freshDb()
    seed(db)
    const app = new Hono()
    await mountMcp(app, {
      db,
      service: "teams",
      vision: { fetchImage: async () => null, captionImage: async () => null },
      search: fakeSearch(),
    })
    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
        url = `http://127.0.0.1:${info.port}/mcp`
        resolve()
      })
    })
    client = new Client({ name: "test-client", version: "0" }, { capabilities: {} })
    await client.connect(new StreamableHTTPClientTransport(new URL(url)))
  })

  afterAll(async () => {
    await client.close()
    server.close()
  })

  test("lists all 8 retrieval tools", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name).sort()
    expect(names).toEqual(
      [
        "get_context",
        "get_unread_overview",
        "list_conversations",
        "list_scopes",
        "resolve_person",
        "resolve_scope",
        "search_messages",
        "view_image",
      ].sort(),
    )
  })

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args })
    const text = (res.content as Array<{ type: string; text?: string }>).find(
      (c) => c.type === "text",
    )?.text
    return text ? JSON.parse(text) : null
  }

  test("search_messages finds a seeded local hit (Vietnamese-safe fold)", async () => {
    const out = await call("search_messages", { query: "deploy" })
    expect(out.rows).toHaveLength(1)
    expect(out.rows[0]).toMatchObject({ convId: "c1", msgId: "m1", sender: "Bob" })
    expect(out.rows[0].snippet).toContain("deploy")
    expect(out.fallbackRan).toBe(true) // local < limit → substrate consulted (no match here)
  })

  test("search_messages falls back to substrate when local is empty (PSN-115 data plane)", async () => {
    const out = await call("search_messages", { query: "standup" })
    expect(out.rows).toHaveLength(1)
    expect(out.rows[0]).toMatchObject({ convId: "c2", msgId: "m9", substrate: true })
  })

  test("get_context returns the seeded thread", async () => {
    const rows = await call("get_context", { convId: "c1" })
    expect(rows.map((r: { msgId: string }) => r.msgId)).toEqual(["m1", "m2"])
  })

  test("list_conversations returns the seeded conv", async () => {
    const rows = await call("list_conversations", {})
    expect(rows.map((r: { id: string }) => r.id)).toContain("c1")
  })

  test("resolve_person fold-matches a name", async () => {
    const rows = await call("resolve_person", { name: "bob" })
    expect(rows.some((r: { displayName: string }) => /bob/i.test(r.displayName))).toBe(true)
  })

  test("view_image on a message with no images returns an honest error", async () => {
    const out = await call("view_image", { convId: "c1", msgId: "m1" })
    expect(out).toMatchObject({ error: expect.stringContaining("no images") })
  })

  test("resources: chat://conversations lists seeded convs", async () => {
    const res = await client.listResources()
    expect(res.resources.map((r) => r.name)).toContain("conversations")
    const rd = await client.readResource({ uri: "chat://conversations" })
    const rows = JSON.parse((rd.contents as Array<{ text: string }>)[0].text) as Array<{
      id: string
    }>
    expect(rows.map((r) => r.id)).toContain("c1")
  })

  test("resources: chat://conversation/{convId} returns the thread", async () => {
    const rd = await client.readResource({ uri: "chat://conversation/c1" })
    const msgs = JSON.parse((rd.contents as Array<{ text: string }>)[0].text) as Array<{
      msgId: string
    }>
    expect(msgs.map((m) => m.msgId)).toEqual(["m1", "m2"])
  })

  test("prompts: 3 templates registered, find-decision carries the topic", async () => {
    const list = await client.listPrompts()
    expect(list.prompts.map((p) => p.name).sort()).toEqual(
      ["catch-up-on-unread", "find-decision", "summarize-conversation"].sort(),
    )
    const got = await client.getPrompt({ name: "find-decision", arguments: { topic: "deploy" } })
    expect((got.messages[0].content as { text: string }).text).toContain("deploy")
  })

  test("stateless: no Mcp-Session-Id returned on initialize", async () => {
    // A second, independent client initializes without sending any session id and succeeds —
    // stateless servers must not require one.
    const c2 = new Client({ name: "second", version: "0" }, { capabilities: {} })
    await c2.connect(new StreamableHTTPClientTransport(new URL(url)))
    const tools = await c2.listTools()
    expect(tools.tools.length).toBe(8)
    await c2.close()
  })
})

describe("MCP Origin gate (L2, raw fetch)", () => {
  let server: ReturnType<typeof serve>
  let url: string

  beforeAll(async () => {
    const app = new Hono()
    await mountMcp(app, { db: freshDb(), service: "teams" })
    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
        url = `http://127.0.0.1:${info.port}/mcp`
        resolve()
      })
    })
  })
  afterAll(() => server.close())

  test("cross-origin POST rejected (DNS rebinding defense)", async () => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "t", version: "0" },
        },
      }),
    })
    expect(res.status).toBe(403)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Write tools (ADR-0026). The read-only suite above mounts WITHOUT `write` and asserts exactly 8
// tools — that is the guard for decision 3 (writes opt-in), so it must stay as it is.
describe("write tools (L3, real client)", () => {
  let server: ReturnType<typeof serve>
  let client: Client
  let db: Database.Database
  let calls: Array<{ fn: string; args: unknown[] }>
  let fail: string | null

  /** Records what reached the provider — the point is that MCP calls the SAME methods routes.ts
   *  does, with the same arguments. `fail` makes the next provider call throw. */
  function spyProvider() {
    const rec =
      (fn: string) =>
      async (...args: unknown[]) => {
        if (fail === fn) throw new Error(`${fn}_upstream_failed`)
        calls.push({ fn, args })
        return fn === "sendReply"
          ? { ok: true, ts: "9000", clientMessageId: "cmid-9000" }
          : undefined
      }
    return {
      sendReply: rec("sendReply"),
      react: rec("react"),
      edit: rec("edit"),
      delete: rec("delete"),
      markRead: rec("markRead"),
      markUnread: rec("markUnread"),
    } as unknown as ChatProvider
  }

  beforeAll(async () => {
    db = freshDb()
    seed(db)
    calls = []
    fail = null
    const app = new Hono()
    await mountMcp(app, {
      db,
      service: "teams",
      write: {
        provider: spyProvider(),
        markConversationRead: (convId, ts) => markConversationRead(db, "teams", convId, ts),
        markConversationUnread: (convId, ts) => markConversationUnread(db, "teams", convId, ts),
      },
    })
    let url = ""
    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
        url = `http://127.0.0.1:${info.port}/mcp`
        resolve()
      })
    })
    client = new Client({ name: "test-client", version: "0" }, { capabilities: {} })
    await client.connect(new StreamableHTTPClientTransport(new URL(url)))
  })

  afterAll(async () => {
    await client.close()
    server.close()
  })

  beforeEach(() => {
    calls = []
    fail = null
  })

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args })
    const text = (res.content as Array<{ type: string; text?: string }>).find(
      (c) => c.type === "text",
    )?.text
    // A thrown tool reports isError with a plain-text message, not JSON — don't parse those.
    if (res.isError) return { body: null, isError: true, message: text ?? "" }
    return { body: text ? JSON.parse(text) : null, isError: false, message: text ?? "" }
  }

  test("registers the 6 write tools alongside the read ones", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names.filter((n) => WRITE_TOOLS.includes(n)).sort()).toEqual([...WRITE_TOOLS].sort())
    // vision/search were not injected here, so view_image is absent — 7 read + 6 write.
    expect(names).toHaveLength(13)
  })

  test("every write tool declares readOnlyHint:false; delete/edit are destructive", async () => {
    const tools = (await client.listTools()).tools
    const byName = new Map(tools.map((t) => [t.name, t.annotations]))
    for (const n of WRITE_TOOLS) expect(byName.get(n)?.readOnlyHint).toBe(false)
    expect(byName.get("delete_message")?.destructiveHint).toBe(true)
    expect(byName.get("edit_message")?.destructiveHint).toBe(true)
    // Retrying these converges on the same state; a client may auto-retry them.
    expect(byName.get("mark_read")?.idempotentHint).toBe(true)
    expect(byName.get("react_to_message")?.idempotentHint).toBe(true)
    // A read tool must NOT be mislabelled as a write.
    expect(byName.get("search_messages")?.readOnlyHint).not.toBe(false)
  })

  // SendResult names the new id `ts`. An agent that just sent a message must be able to edit or
  // delete it without re-reading the thread and guessing which row is his, so the tool republishes
  // it as `msgId` — the key edit_message/delete_message actually take.
  test("send_reply returns the new message id as msgId, not just ts", async () => {
    const { body } = await call("send_reply", { convId: "c1", text: "on it" })
    expect(calls).toEqual([{ fn: "sendReply", args: ["c1", "on it"] }])
    expect(body.msgId).toBe("9000")
    expect(body.ts).toBe("9000")
  })

  test("react_to_message passes the remove flag through", async () => {
    await call("react_to_message", { convId: "c1", msgId: "m1", key: "like" })
    await call("react_to_message", { convId: "c1", msgId: "m1", key: "like", remove: true })
    expect(calls.map((c) => c.args)).toEqual([
      ["c1", "m1", "like", false],
      ["c1", "m1", "like", true],
    ])
  })

  test("edit_message and delete_message reach their provider methods", async () => {
    await call("edit_message", { convId: "c1", msgId: "m1", text: "fixed typo" })
    await call("delete_message", { convId: "c1", msgId: "m1" })
    expect(calls).toEqual([
      { fn: "edit", args: ["c1", "m1", "fixed typo"] },
      { fn: "delete", args: ["c1", "m1"] },
    ])
  })

  test("mark_read writes THROUGH: provider first, then the local row", async () => {
    const { body } = await call("mark_read", { convId: "c1", ts: 2000 })
    expect(body).toEqual({ ok: true })
    expect(calls).toEqual([{ fn: "markRead", args: ["c1", "", 2000] }])
    expect(readStateOf("c1")).toMatchObject({ localReadTs: 2000, readTs: 2000 })
  })

  test("mark_unread syncs the flag and the local row", async () => {
    await call("mark_unread", { convId: "c1", ts: 1500 })
    expect(calls).toEqual([{ fn: "markUnread", args: ["c1", 1500] }])
    // The bookmark sits AT 1500, so everything from 1500 on reads unread: effective read is 1499.
    expect(readStateOf("c1")?.readTs).toBe(1499)
  })

  // ADR-0022's rule, and ADR-0026 decision 2: if the service rejects the write, the local row must
  // NOT move — otherwise the UI shows read while Teams still shows unread, and nothing reconciles.
  test("a failed provider write leaves local read state untouched", async () => {
    await call("mark_read", { convId: "c1", ts: 3000 })
    const before = readStateOf("c1")?.localReadTs
    expect(before).toBe(3000)
    fail = "markRead"
    const { isError, message } = await call("mark_read", { convId: "c1", ts: 8888 })
    expect(isError).toBe(true)
    expect(message).toContain("markRead_upstream_failed")
    expect(readStateOf("c1")?.localReadTs).toBe(3000)
  })

  // Read through the store's own accessor, not raw SQL — the read watermark lives in `read_state`,
  // not on the conversation row, and this keeps the assertion honest if that layout moves.
  const readStateOf = (convId: string) => getReadState(db, "teams", convId)
})
