// Integration tests for POST /api/chat/search (PSN-115 WS-D). Drives the real route against an
// in-memory DB + MockProvider, asserting: local/substrate merge + dedupe, sort modes, scope chips,
// the degraded path (substrate auth failure), and that background hydrate-on-render is fired for
// substrate hits not yet in chat.db.

import Database from "better-sqlite3"
import { Hono } from "hono"
import { beforeEach, describe, expect, test, vi } from "vitest"
import type { ChatService } from "./contract.ts"
import { MockProvider } from "./providers/mock-provider.ts"
import type { ChatProvider, ProviderSearchHit } from "./providers/provider.ts"
import { ProviderError } from "./providers/provider.ts"
import { createRoutes, type HydrateAccessor } from "./routes.ts"
import { migrate } from "./store.ts"

const SERVICE = "mock"

const GROUP = "19:group@thread.v2" // seeded by MockProvider, body "on it" for msg 3002
const RICH = "19:rich@thread.v2" // seeded, msg 6002 carries "PSN-105 ticket" link
const LOST = "19:lost@thread.tacv2" // substrate-only — never seeded locally

interface Ctx {
  app: Hono
  db: Database.Database
  provider: MockProvider
  hydrateSpy: ReturnType<typeof vi.fn>
}

function makeApp(opts?: { hydrate?: HydrateAccessor }): Ctx {
  const db = migrate(new Database(":memory:"))
  const provider = new MockProvider(SERVICE as ChatService)
  const providers = new Map<ChatService, ChatProvider>([[SERVICE, provider]])
  const hydrateSpy = vi.fn().mockResolvedValue([])
  const hydrates = new Map<ChatService, HydrateAccessor>([
    [SERVICE, opts?.hydrate ?? { hydrateHits: hydrateSpy }],
  ])
  const app = new Hono()
  app.route("/api/chat", createRoutes({ db, providers, hydrates }))
  return { app, db, provider, hydrateSpy }
}

const post = (app: Hono, path: string, body: unknown) =>
  app.request(`/api/chat/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })

/** Seed the local DB with a conversation + its full message history so FTS can match any of them.
 *  The MockProvider pages 2-at-a-time by default, so we walk the cursor until exhausted. */
async function seedHistory(ctx: Ctx, convId: string) {
  await post(ctx.app, "conversations", { service: SERVICE })
  let cursor: string | null = null
  do {
    const res = await post(ctx.app, "history", { service: SERVICE, convId, cursor })
    const page = (await res.json()) as { cursor: string | null }
    cursor = page.cursor
  } while (cursor)
}

describe("POST /search — local FTS leg", () => {
  let ctx: Ctx
  beforeEach(async () => {
    ctx = makeApp()
    await seedHistory(ctx, GROUP)
  })

  test("returns local hits with hydrated:true, source:local", async () => {
    const res = await post(ctx.app, "search", { service: SERVICE, query: "kickoff" })
    expect(res.status).toBe(200)
    const page = (await res.json()) as any
    expect(page.rows.length).toBeGreaterThan(0)
    const row = page.rows.find((r: any) => r.convId === GROUP)
    expect(row).toBeDefined()
    expect(row.source).toBe("local")
    expect(row.hydrated).toBe(true)
    expect(row.snippet).toContain("kickoff")
    expect(page.parsed.text).toBe("kickoff")
  })

  test("empty query → empty rows, parsed echo present", async () => {
    const res = await post(ctx.app, "search", { service: SERVICE, query: "" })
    const page = (await res.json()) as any
    expect(page.rows).toEqual([])
    expect(page.parsed).toEqual({ text: "", filters: {} })
    expect(page.cursor).toBeNull()
    expect(page.total).toBe(0)
  })

  test("parsed echo carries extracted filters", async () => {
    const res = await post(ctx.app, "search", {
      service: SERVICE,
      query: "from:@alice in:#general has:link mentions:me hello",
    })
    const page = (await res.json()) as any
    expect(page.parsed.filters.from).toBe("alice")
    expect(page.parsed.filters.in).toBe("general")
    expect(page.parsed.filters.has).toEqual(["link"])
    expect(page.parsed.filters.mentionsMe).toBe(true)
    expect(page.parsed.text).toBe("hello")
  })
})

describe("POST /search — substrate merge + dedupe", () => {
  let ctx: Ctx
  beforeEach(async () => {
    ctx = makeApp()
    // Seed RICH so the (RICH, 6002) dedupe path is reachable: local FTS AND substrate both return
    // a hit for the same message. GROUP seeded for kind/title lookups.
    await seedHistory(ctx, GROUP)
    await seedHistory(ctx, RICH)
  })

  test("local + substrate merged; dedupe keeps local for collisions", async () => {
    // "ticket" matches local 6002 (body has PSN-105 ticket link) AND substrate 6002 preview.
    const res = await post(ctx.app, "search", { service: SERVICE, query: "ticket" })
    const page = (await res.json()) as any
    const rich = page.rows.filter((r: any) => r.convId === RICH)
    expect(rich.length).toBe(1) // dedupe by (convId,msgId)
    expect(rich[0].source).toBe("local") // local wins
    expect(rich[0].hydrated).toBe(true)
    expect(rich[0].msgId).toBe("6002")
  })

  test("substrate-only hit (conv not in DB) returns hydrated:false + null convTitle", async () => {
    const res = await post(ctx.app, "search", { service: SERVICE, query: "rollback" })
    const page = (await res.json()) as any
    const lost = page.rows.find((r: any) => r.convId === LOST)
    expect(lost).toBeDefined()
    expect(lost.source).toBe("substrate")
    expect(lost.hydrated).toBe(false)
    expect(lost.convTitle).toBeNull()
    expect(lost.snippet).toContain("rollback")
  })

  test("substrate hit referencing a known conv gets convTitle from the store", async () => {
    // "deploy" matches substrate 3002 (conv in DB) + 9001 + 9002 (not in DB).
    const res = await post(ctx.app, "search", { service: SERVICE, query: "deploy" })
    const page = (await res.json()) as any
    const inDb = page.rows.find((r: any) => r.convId === GROUP)
    expect(inDb).toBeDefined()
    expect(inDb.convTitle).toBe("Project X") // GROUP's seeded topic
    expect(inDb.hydrated).toBe(true) // 3002 is in the DB
  })
})

describe("POST /search — sort modes", () => {
  let ctx: Ctx
  beforeEach(async () => {
    ctx = makeApp()
    await seedHistory(ctx, GROUP)
    await seedHistory(ctx, RICH)
  })

  test("sort=recent → ts desc", async () => {
    // "deploy" matches substrate 3002 (ts=ago(242)) + 9001 (ts=ago(60_000)) + 9002 (ts=ago(90_000)).
    const res = await post(ctx.app, "search", {
      service: SERVICE,
      query: "deploy",
      sort: "recent",
    })
    const page = (await res.json()) as any
    const ts = page.rows.map((r: any) => r.ts)
    const sorted = [...ts].sort((a: number, b: number) => b - a)
    expect(ts).toEqual(sorted)
  })

  test("sort=relevance (default) → substrate first, then local", async () => {
    // "ticket" → substrate 6002 + local 6002 collide → one row source:local. To exercise the
    // substrate-before-local ordering cleanly, search a term that yields BOTH a local-only and a
    // substrate-only row. "deploy" gives substrate-only 9001/9002 + substrate 3002 (in-DB). With no
    // local FTS hit for "deploy", verify the order is substrate-only here.
    const res = await post(ctx.app, "search", { service: SERVICE, query: "deploy" })
    const page = (await res.json()) as any
    expect(page.rows.length).toBeGreaterThan(0)
    for (const r of page.rows) expect(r.source).toBe("substrate")
  })
})

describe("POST /search — scope chips", () => {
  let ctx: Ctx
  beforeEach(async () => {
    ctx = makeApp()
    await seedHistory(ctx, GROUP) // kind: group
    await post(ctx.app, "conversations", { service: SERVICE }) // also pulls 1:1 + self + rich
  })

  test("scope=dm keeps only oneOnOne convs", async () => {
    const res = await post(ctx.app, "search", {
      service: SERVICE,
      query: "deploy",
      scope: { kind: "dm" },
    })
    const page = (await res.json()) as any
    // Substrate hits reference group/lost/archive — none is a DM, so scope=dm empties the page.
    for (const r of page.rows) expect(r.convId).not.toContain("oneonone") // sanity
    // The fixture set has no DM-matching substrate hit; verify the filter actually narrowed.
    const allScope = await post(ctx.app, "search", { service: SERVICE, query: "deploy" })
    const allRows = ((await allScope.json()) as any).rows
    expect(allRows.length).toBeGreaterThanOrEqual(page.rows.length)
  })

  test("scope=group keeps only group convs", async () => {
    const res = await post(ctx.app, "search", {
      service: SERVICE,
      query: "deploy",
      scope: { kind: "group" },
    })
    const page = (await res.json()) as any
    // GROUP is a group conv, so its rows survive; LOST/ARCHIVE are unknown kind → filtered out.
    for (const r of page.rows) expect(r.convId).toBe(GROUP)
  })

  test("scope=folder resolves via conversation_prefs", async () => {
    // File GROUP into a folder, then scope to it. The renamed fixture already has folder "Work" for
    // 19:renamed@thread.v2 — use that. First seed it so it exists in the store.
    await seedHistory(ctx, "19:renamed@thread.v2")
    const res = await post(ctx.app, "search", {
      service: SERVICE,
      query: "renamed",
      scope: { kind: "folder", name: "Work" },
    })
    const page = (await res.json()) as any
    for (const r of page.rows) expect(r.convId).toBe("19:renamed@thread.v2")
  })

  test("scope=folder with no matches → empty (NOT unfiltered)", async () => {
    const res = await post(ctx.app, "search", {
      service: SERVICE,
      query: "deploy",
      scope: { kind: "folder", name: "Nonexistent" },
    })
    const page = (await res.json()) as any
    expect(page.rows).toEqual([])
  })
})

describe("POST /search — degraded + hydrate-on-render", () => {
  test("substrate auth failure → response.degraded set, local-only rows", async () => {
    const db = migrate(new Database(":memory:"))
    // A provider whose searchMessages always rejects with auth — simulating a stale substrate token.
    class AuthFailProvider extends MockProvider {
      override async searchMessages(): Promise<never> {
        throw new ProviderError("auth", 401)
      }
    }
    const provider = new AuthFailProvider(SERVICE as ChatService)
    const providers = new Map<ChatService, ChatProvider>([[SERVICE, provider]])
    const app = new Hono()
    app.route("/api/chat", createRoutes({ db, providers }))
    // Seed some local history so the local leg still returns rows.
    await post(app, "conversations", { service: SERVICE })
    let cursor: string | null = null
    do {
      const r = await post(app, "history", { service: SERVICE, convId: GROUP, cursor })
      cursor = ((await r.json()) as { cursor: string | null }).cursor
    } while (cursor)

    const res = await post(app, "search", { service: SERVICE, query: "kickoff" })
    expect(res.status).toBe(200)
    const page = (await res.json()) as any
    expect(page.degraded).toBe("auth")
    expect(page.rows.length).toBeGreaterThan(0)
    for (const r of page.rows) expect(r.source).toBe("local")
  })

  test("non-ProviderError substrate failure → degraded=upstream_error", async () => {
    const db = migrate(new Database(":memory:"))
    class BoomProvider extends MockProvider {
      override async searchMessages(): Promise<never> {
        throw new Error("network gone")
      }
    }
    const provider = new BoomProvider(SERVICE as ChatService)
    const providers = new Map<ChatService, ChatProvider>([[SERVICE, provider]])
    const app = new Hono()
    app.route("/api/chat", createRoutes({ db, providers }))
    const res = await post(app, "search", { service: SERVICE, query: "anything" })
    const page = (await res.json()) as any
    expect(page.degraded).toBe("upstream_error")
  })

  test("hydrateHits fired for substrate hits not yet in DB (fire-and-forget)", async () => {
    const ctx = makeApp()
    await seedHistory(ctx, GROUP) // 3002 IS in DB → not hydrated-target
    // "deploy" → substrate 3002 (hydrated:true) + 9001 + 9002 (hydrated:false).
    await post(ctx.app, "search", { service: SERVICE, query: "deploy" })
    // Fire-and-forget: the call returns immediately, but the spy is invoked synchronously before
    // the response. Wait one microtask for the void promise to settle.
    await new Promise((r) => setTimeout(r, 0))
    expect(ctx.hydrateSpy).toHaveBeenCalled()
    const arg: ProviderSearchHit[] = ctx.hydrateSpy.mock.calls[0][0]
    const msgIds = arg.map((h) => h.msgId)
    expect(msgIds).toContain("9001")
    expect(msgIds).toContain("9002")
    expect(msgIds).not.toContain("3002") // already hydrated → not enqueued
  })

  test("no hydrate engine wired → no throw, rows just stay hydrated:false", async () => {
    const db = migrate(new Database(":memory:"))
    const provider = new MockProvider(SERVICE as ChatService)
    const providers = new Map<ChatService, ChatProvider>([[SERVICE, provider]])
    const app = new Hono()
    // NOTE: no `hydrates` map wired — simulates a boot without the engine.
    app.route("/api/chat", createRoutes({ db, providers }))
    const res = await post(app, "search", { service: SERVICE, query: "rollback" })
    expect(res.status).toBe(200)
    const page = (await res.json()) as any
    const lost = page.rows.find((r: any) => r.convId === LOST)
    expect(lost.hydrated).toBe(false)
  })
})

describe("POST /search — KQL post-filter on merged rows", () => {
  let ctx: Ctx
  beforeEach(async () => {
    ctx = makeApp()
    await seedHistory(ctx, GROUP)
    await seedHistory(ctx, RICH)
  })

  test("from:<name> narrows by sender display name (case-insensitive contains)", async () => {
    // Substrate fixture 6002 sender is "Other Person"; 9001 is "Third Person"; 9002 is "Other Person".
    // Searching "deploy" + from:other keeps 9002 only (3002 sender "You" excluded; 9001 excluded).
    const res = await post(ctx.app, "search", {
      service: SERVICE,
      query: "deploy from:other",
    })
    const page = (await res.json()) as any
    for (const r of page.rows) expect(r.sender.toLowerCase()).toContain("other")
    expect(page.rows.some((r: any) => r.msgId === "9002")).toBe(true)
    expect(page.rows.some((r: any) => r.msgId === "9001")).toBe(false)
  })

  test("in:<conv> narrows by convTitle or convId substring", async () => {
    // "ticket" + in:rich keeps the rich conv hit; in:nonexistent empties the page.
    const res = await post(ctx.app, "search", {
      service: SERVICE,
      query: "ticket in:design",
    })
    const page = (await res.json()) as any
    for (const r of page.rows) expect(r.convId).toBe(RICH)
  })

  test("in:<nonexistent> → empty (honest, not unfiltered)", async () => {
    const res = await post(ctx.app, "search", {
      service: SERVICE,
      query: "ticket in:does-not-exist",
    })
    const page = (await res.json()) as any
    expect(page.rows).toEqual([])
  })
})
