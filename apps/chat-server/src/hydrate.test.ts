import Database from "better-sqlite3"
import { beforeEach, describe, expect, test } from "vitest"
import type { ChatMessage } from "./contract.ts"
import { createHydrateEngine } from "./hydrate.ts"
import type { ChatProvider, ProviderSearchHit } from "./providers/provider.ts"
import { ProviderError } from "./providers/provider.ts"
import { stubProvider } from "./providers/stub-provider.ts"
import { searchMessages } from "./search.ts"
import { hasMessage, migrate, upsertConversations, upsertMessages } from "./store.ts"

const SERVICE = "mock"
const NOW = 1_000_000_000_000
const DAY = 86_400_000

function msg(id: string, ts: number, body: string): ChatMessage {
  return { service: SERVICE, id, ts, body }
}

function hit(convId: string, msgId: string, preview = "deploy plan"): ProviderSearchHit {
  return { convId, msgId, preview, sender: "You", ts: NOW - 1 * DAY, subject: "" }
}

/** A provider paging one conversation backward: page N is older than page N−1. Cursor is the page
 *  index as a string; null ends. `throwAtPage` injects a 429 at a given page (1-based). `calls`
 *  counts fetchHistory invocations. */
class PagedProvider {
  provider: ChatProvider
  throwAtPage: number | null = null
  throwCode: string = "rate_limited"
  calls = 0
  constructor(private pages: ChatMessage[][]) {
    this.provider = stubProvider({
      service: SERVICE,
      fetchHistory: async (_convId, cursor) => {
        this.calls++
        const idx = cursor ? Number(cursor) : 0
        if (this.throwAtPage && this.calls === this.throwAtPage) {
          throw new ProviderError(this.throwCode, this.throwCode === "rate_limited" ? 429 : 401)
        }
        const messages = this.pages[idx] ?? []
        const next = idx + 1 < this.pages.length ? String(idx + 1) : null
        return { messages, cursor: next }
      },
    })
  }
}

function makeDb() {
  const db = migrate(new Database(":memory:"))
  upsertConversations(db, SERVICE, [{ id: "c", lastMessageVersion: 1, lastMessageTs: NOW }])
  return db
}

function makeEngine(db: Database.Database, paged: PagedProvider) {
  const engine = createHydrateEngine({
    db,
    provider: paged.provider,
    service: SERVICE,
    sleep: async () => {},
    pageDelayMs: 0,
  })
  return { engine }
}

describe("hydrate pipeline", () => {
  let db: Database.Database
  beforeEach(() => {
    db = makeDb()
  })

  test("a missing hit's conv window lands in chat.db and the FTS index finds it", async () => {
    const provider = new PagedProvider([
      [msg("2", NOW - 1 * DAY, "ship it"), msg("1", NOW - 2 * DAY, "deploy plan v1")],
    ])
    const { engine } = makeEngine(db, provider)

    const out = await engine.hydrateHit(hit("c", "1", "deploy"))
    expect(out).toEqual({ hydrated: true, reason: "fetched" })

    expect(hasMessage(db, SERVICE, "c", "1")).toBe(true)
    // The hydrate upsert path goes through store.upsertMessages so the FTS shadow syncs — WS-D's
    // local re-query must find the newly-hydrated term.
    expect(searchMessages(db, { query: "deploy" }).map((h) => h.msgId)).toContain("1")
  })

  test("already in DB → already_present no-op (idempotent)", async () => {
    upsertMessages(db, SERVICE, "c", [{ id: "1", ts: NOW - 2 * DAY, body: "deploy plan v1" }])
    const provider = new PagedProvider([[msg("2", NOW - 1 * DAY, "ship it")]])
    const { engine } = makeEngine(db, provider)

    const out = await engine.hydrateHit(hit("c", "1"))
    expect(out).toEqual({ hydrated: false, reason: "already_present" })
    expect(provider.calls).toBe(0) // never reached the provider
  })

  test("two concurrent hits for the same conv share ONE fetch pass", async () => {
    const provider = new PagedProvider([
      [
        msg("3", NOW - 1 * DAY, "third"),
        msg("2", NOW - 2 * DAY, "second"),
        msg("1", NOW - 3 * DAY, "first"),
      ],
    ])
    const { engine } = makeEngine(db, provider)

    // Two hits in the same conv, both missing — issued in parallel.
    const [a, b] = await Promise.all([
      engine.hydrateHit(hit("c", "2", "second")),
      engine.hydrateHit(hit("c", "1", "first")),
    ])
    // One fetch pass for the conversation, not two.
    expect(provider.calls).toBe(1)
    // The shared pass hydrated a page containing BOTH messages — A drove the fetch and reports
    // `fetched`; B joined the in-flight promise and reports `already_present` because by the time
    // it re-checked, its message had landed as a side effect (idempotent + single-flight both work).
    expect(a).toEqual({ hydrated: true, reason: "fetched" })
    expect(b).toEqual({ hydrated: false, reason: "already_present" })
    expect(hasMessage(db, SERVICE, "c", "2")).toBe(true)
    expect(hasMessage(db, SERVICE, "c", "1")).toBe(true)
  })

  test("a hit whose msgId is never returned → not_found_upstream, no throw", async () => {
    const provider = new PagedProvider([
      [msg("visible", NOW - 1 * DAY, "unrelated")], // page has no "9999"
    ])
    const { engine } = makeEngine(db, provider)

    const out = await engine.hydrateHit(hit("c", "9999"))
    expect(out).toEqual({ hydrated: false, reason: "not_found_upstream" })
    // The visible page was still upserted (side effect — store-first is fine; the hydrate window
    // isn't wasted work even when our specific hit wasn't found).
    expect(hasMessage(db, SERVICE, "c", "visible")).toBe(true)
  })

  test("rate_limited → returns the typed reason, no throw", async () => {
    const provider = new PagedProvider([[msg("1", NOW - 1 * DAY, "deploy")]])
    provider.throwAtPage = 1
    const { engine } = makeEngine(db, provider)

    const out = await engine.hydrateHit(hit("c", "1"))
    expect(out).toEqual({ hydrated: false, reason: "rate_limited" })
  })

  test("auth error → returns the auth reason, no throw", async () => {
    const provider = new PagedProvider([[msg("1", NOW - 1 * DAY, "deploy")]])
    provider.throwAtPage = 1
    provider.throwCode = "invalid_auth"
    const { engine } = makeEngine(db, provider)

    const out = await engine.hydrateHit(hit("c", "1"))
    expect(out).toEqual({ hydrated: false, reason: "auth" })
  })

  test("stops at MAX_HYDRATE_PAGES without throwing when the msgId is never found", async () => {
    // Five pages, none containing "9999". The runner must page through all 5, then give up cleanly.
    const pages = Array.from({ length: 5 }, (_, i) => [
      msg(`p${i}-0`, NOW - (i + 1) * DAY, `noise-${i}-0`),
      msg(`p${i}-1`, NOW - (i + 1) * DAY - 1, `noise-${i}-1`),
    ])
    const provider = new PagedProvider(pages)
    const { engine } = makeEngine(db, provider)

    const out = await engine.hydrateHit(hit("c", "9999"))
    expect(out).toEqual({ hydrated: false, reason: "not_found_upstream" })
    expect(provider.calls).toBe(5)
  })

  test("hydrateHits batches — mixed already-present + fresh + not-found", async () => {
    upsertMessages(db, SERVICE, "c", [{ id: "present", ts: NOW - DAY, body: "already here" }])
    const provider = new PagedProvider([
      [msg("fresh", NOW - 1 * DAY, "fresh body"), msg("present", NOW - 2 * DAY, "already here")],
    ])
    const { engine } = makeEngine(db, provider)

    const results = await engine.hydrateHits([
      hit("c", "present"), // skip
      hit("c", "fresh"), // fetch + found
      hit("c", "ghost"), // fetch + not found in the single page (no further pages)
    ])
    expect(results).toEqual([
      { hydrated: false, reason: "already_present" },
      { hydrated: true, reason: "fetched" },
      { hydrated: false, reason: "not_found_upstream" },
    ])
    // present stayed, fresh landed; ghost did not.
    expect(hasMessage(db, SERVICE, "c", "present")).toBe(true)
    expect(hasMessage(db, SERVICE, "c", "fresh")).toBe(true)
    expect(hasMessage(db, SERVICE, "c", "ghost")).toBe(false)
  })
})
