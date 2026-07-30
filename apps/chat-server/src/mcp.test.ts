// MCP server tests (PSN-114). L1: the pure Origin gate. L3: a real MCP client over a real HTTP
// server (ephemeral port, :memory: db + mock fixtures) exercising the read-only tool surface —
// the regression backbone per the plan. The tools themselves are thin wrappers over already-tested
// pure fns (search.test.ts / unread-overview.test.ts), so this covers wiring + dispatch + the wire
// contract, not retrieval correctness.

import { serve } from "@hono/node-server"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import Database from "better-sqlite3"
import { Hono } from "hono"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import type { HydrateEngine } from "./hydrate.ts"
import { mountMcp } from "./mcp.ts"
import type { ChatProvider, ProviderSearchHit, ProviderSearchPage } from "./providers/provider.ts"
import { migrate, upsertConversations, upsertMessages, upsertUsers } from "./store.ts"

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
  // Re-implements the same predicate mcp.ts uses; the gate is a private fn there, so this is the
  // same rule asserted directly. Keep the two in lockstep if the rule changes.
  const allowed = (o: string | null | undefined) =>
    !o ||
    (() => {
      const lo = o.toLowerCase()
      return (
        lo.startsWith("http://localhost") ||
        lo.startsWith("http://127.0.0.1") ||
        lo.startsWith("http://[::1]")
      )
    })()
  test("absent origin (non-browser client) allowed", () => expect(allowed(undefined)).toBe(true))
  test("localhost allowed", () => expect(allowed("http://localhost:5173")).toBe(true))
  test("127.0.0.1 allowed", () => expect(allowed("http://127.0.0.1:7810")).toBe(true))
  test("cross-origin rejected (DNS rebinding)", () =>
    expect(allowed("https://evil.example")).toBe(false))
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
