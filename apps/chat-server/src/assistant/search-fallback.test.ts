// WS-C (PSN-115): search_messages falls back to substrate + hydrate when local FTS is thin.
// Hermetic — no network. A fake provider and a fake hydrate let us pin each branch.

import Database from "better-sqlite3"
import { beforeEach, describe, expect, test, vi } from "vitest"
import type { HydrateEngine, HydrateResult } from "../hydrate.ts"
import type { ChatProvider, ProviderSearchHit, ProviderSearchPage } from "../providers/provider.ts"
import { ProviderError } from "../providers/provider.ts"
import { migrate, upsertMessages } from "../store.ts"
import { createAssistantTools } from "./loop.ts"

function freshDb() {
  return migrate(new Database(":memory:"))
}

function fakeProvider(opts: {
  hits?: ProviderSearchHit[]
  throwCode?: string
}): Pick<ChatProvider, "searchMessages"> {
  return {
    async searchMessages(query): Promise<ProviderSearchPage> {
      if (opts.throwCode) throw new ProviderError(opts.throwCode, 502)
      const q = query.trim().toLowerCase()
      const rows = (opts.hits ?? []).filter((h) => h.preview.toLowerCase().includes(q))
      return { rows, cursor: null, total: rows.length }
    },
  }
}

function fakeHydrate(spy: (hits: ProviderSearchHit[]) => void): Pick<HydrateEngine, "hydrateHits"> {
  return {
    async hydrateHits(hits): Promise<HydrateResult[]> {
      spy(hits)
      // Caller inserts into the DB itself before re-query, simulating the window landing.
      return hits.map(() => ({ hydrated: true, reason: "fetched" }))
    },
  }
}

const SUBSTRATE_HIT: ProviderSearchHit = {
  convId: "c2",
  msgId: "m9",
  preview: "deploy happened on friday",
  sender: "Carol",
  ts: 5000,
  subject: "",
}

describe("search_messages fallback (WS-C)", () => {
  let db: ReturnType<typeof freshDb>
  beforeEach(() => {
    db = freshDb()
  })

  test("local hits at or above limit → no substrate call", async () => {
    upsertMessages(db, "teams", "c1", [
      { id: "m1", ts: 1000, senderName: "Bob", body: "deploy a" },
      { id: "m2", ts: 2000, senderName: "Bob", body: "deploy b" },
    ])
    const provider = fakeProvider({ hits: [SUBSTRATE_HIT] })
    const searchSpy = vi.spyOn(provider, "searchMessages")
    const tools = createAssistantTools(db, "teams", () => {}, undefined, {
      provider: provider as ChatProvider,
      hydrate: fakeHydrate(() => {}) as HydrateEngine,
    })
    // biome-ignore lint/suspicious/noExplicitAny: SDK execute opts unused
    const out = await tools.search_messages.execute?.({ query: "deploy", limit: 2 }, {} as any)
    expect(searchSpy).not.toHaveBeenCalled()
    // Returns a plain array when no fallback fires (back-compat with existing tool contract).
    expect(Array.isArray(out)).toBe(true)
    expect((out as Array<{ msgId: string }>).map((r) => r.msgId)).toEqual(["m2", "m1"])
  })

  test("local thin → substrate called, hydrate fired, re-query surfaces the hydrated row", async () => {
    // One local hit but limit 20 → thin → fallback fires.
    upsertMessages(db, "teams", "c1", [
      { id: "m1", ts: 1000, senderName: "Bob", body: "deploy local" },
    ])
    const provider = fakeProvider({ hits: [SUBSTRATE_HIT] })
    const searchSpy = vi.spyOn(provider, "searchMessages")
    const hydrateSpy = vi.fn()
    const tools = createAssistantTools(db, "teams", () => {}, undefined, {
      provider: provider as ChatProvider,
      hydrate: fakeHydrate(hydrateSpy) as HydrateEngine,
    })

    // Hydrate's side effect: simulate the window landing before re-query. The hydrate promise
    // resolves on the same tick the re-query reads, so seed the row now.
    hydrateSpy.mockImplementation(() => {
      upsertMessages(db, "teams", "c2", [
        { id: "m9", ts: 5000, senderName: "Carol", body: "deploy happened on friday" },
      ])
    })

    // biome-ignore lint/suspicious/noExplicitAny: SDK execute opts unused
    const out = await tools.search_messages.execute?.({ query: "deploy" }, {} as any)
    expect(searchSpy).toHaveBeenCalledOnce()
    expect(hydrateSpy).toHaveBeenCalledOnce()
    expect(hydrateSpy.mock.calls[0][0]).toEqual([SUBSTRATE_HIT])
    const payload = out as { rows: Array<{ msgId: string; substrate?: boolean }> }
    // Hydrated row landed in chat.db → re-query returns it as a real (non-substrate) row.
    expect(payload.rows.map((r) => r.msgId)).toContain("m9")
    expect(payload.rows.find((r) => r.msgId === "m9")?.substrate).toBeUndefined()
  })

  test("substrate-only (un-hydrated) row is returned + citable", async () => {
    // Empty DB, substrate has a hit, but hydrate doesn't land it (no DB write simulated).
    const provider = fakeProvider({ hits: [SUBSTRATE_HIT] })
    const surfaced: string[] = []
    const tools = createAssistantTools(
      db,
      "teams",
      (c, m) => surfaced.push(`${c}:${m}`),
      undefined,
      {
        provider: provider as ChatProvider,
        hydrate: fakeHydrate(() => {}) as HydrateEngine, // no DB write
      },
    )
    // biome-ignore lint/suspicious/noExplicitAny: SDK execute opts unused
    const out = await tools.search_messages.execute?.({ query: "deploy" }, {} as any)
    const payload = out as { rows: Array<{ convId: string; msgId: string; substrate?: boolean }> }
    expect(payload.rows).toHaveLength(1)
    expect(payload.rows[0]).toMatchObject({ convId: "c2", msgId: "m9", substrate: true })
    // The un-hydrated row still goes into the surfaced set so a citation marker survives.
    expect(surfaced).toContain("c2:m9")
  })

  test("provider rate_limited → degrade to local-only with an honest note", async () => {
    upsertMessages(db, "teams", "c1", [
      { id: "m1", ts: 1000, senderName: "Bob", body: "deploy local" },
    ])
    const provider = fakeProvider({ throwCode: "rate_limited" })
    const hydrateSpy = vi.fn()
    const tools = createAssistantTools(db, "teams", () => {}, undefined, {
      provider: provider as ChatProvider,
      hydrate: fakeHydrate(hydrateSpy) as HydrateEngine,
    })
    // biome-ignore lint/suspicious/noExplicitAny: SDK execute opts unused
    const out = await tools.search_messages.execute?.({ query: "deploy" }, {} as any)
    const payload = out as { rows: Array<{ msgId: string }>; note?: string }
    expect(payload.rows.map((r) => r.msgId)).toEqual(["m1"])
    expect(payload.note).toMatch(/upstream search unavailable/i)
    // Hydrate never runs when the provider rejected.
    expect(hydrateSpy).not.toHaveBeenCalled()
  })

  test("provider auth error → same degrade, turn doesn't crash", async () => {
    const provider = fakeProvider({ throwCode: "invalid_auth" })
    const tools = createAssistantTools(db, "teams", () => {}, undefined, {
      provider: provider as ChatProvider,
      hydrate: fakeHydrate(() => {}) as HydrateEngine,
    })
    // biome-ignore lint/suspicious/noExplicitAny: SDK execute opts unused
    const out = await tools.search_messages.execute?.({ query: "nope" }, {} as any)
    const payload = out as { rows: unknown[]; note?: string }
    expect(payload.rows).toEqual([])
    expect(payload.note).toMatch(/upstream search unavailable/i)
  })

  test("no provider/hydrate injected → existing behaviour unchanged (plain array)", async () => {
    upsertMessages(db, "teams", "c1", [
      { id: "m1", ts: 1000, senderName: "Bob", body: "deploy local" },
    ])
    const tools = createAssistantTools(db, "teams", () => {})
    // biome-ignore lint/suspicious/noExplicitAny: SDK execute opts unused
    const out = await tools.search_messages.execute?.({ query: "deploy" }, {} as any)
    expect(Array.isArray(out)).toBe(true)
    expect((out as Array<{ msgId: string }>).map((r) => r.msgId)).toEqual(["m1"])
  })
})
