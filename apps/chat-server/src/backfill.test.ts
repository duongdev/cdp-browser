import Database from "better-sqlite3"
import { beforeEach, describe, expect, test } from "vitest"
import { createBackfillEngine } from "./backfill.ts"
import type { ChatMessage, ChatWsServerMessage } from "./contract.ts"
import type { ChatProvider } from "./providers/provider.ts"
import { ProviderError } from "./providers/provider.ts"
import { stubProvider } from "./providers/stub-provider.ts"
import { getBackfillCursor, listMessages, migrate, upsertConversations } from "./store.ts"

const SERVICE = "mock"
const NOW = 1_000_000_000_000
const DAY = 86_400_000

function msg(id: string, ts: number): ChatMessage {
  return { service: SERVICE, id, ts, body: `m${id}` }
}

/** A provider paging one conversation backward: page N is older than page N−1. Cursor is the page
 *  index as a string; null ends. `throwAtPage` injects a 429 at a given page (1-based). `calls`
 *  counts fetchHistory hits. */
class PagedProvider {
  provider: ChatProvider
  throwAtPage: number | null = null
  calls = 0
  constructor(private pages: ChatMessage[][]) {
    this.provider = stubProvider({
      service: SERVICE,
      fetchHistory: async (_convId, cursor) => {
        this.calls++
        const idx = cursor ? Number(cursor) : 0
        if (this.throwAtPage && this.calls === this.throwAtPage) {
          throw new ProviderError("rate_limited", 429)
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
  // One conversation so listConversationIds returns it.
  upsertConversations(db, SERVICE, [{ id: "c", lastMessageVersion: 1, lastMessageTs: NOW }])
  return db
}

function makeEngine(db: Database.Database, paged: PagedProvider) {
  const sent: ChatWsServerMessage[] = []
  const engine = createBackfillEngine({
    db,
    provider: paged.provider,
    service: SERVICE,
    broadcast: (m) => {
      sent.push(m)
    },
    sleep: async () => {},
    now: () => NOW,
  })
  return { engine, sent }
}

/** Spin the microtask queue until the engine reports not-running (the run is fire-and-forget). */
async function drain(engine: { getBackfillStatus: () => { running: boolean } }) {
  for (let i = 0; i < 100 && engine.getBackfillStatus().running; i++) {
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
  }
}

describe("backfill paging", () => {
  let db: Database.Database
  beforeEach(() => {
    db = makeDb()
  })

  test("pages to the cutoff and stores every page", async () => {
    // 3 pages, newest→oldest. Cutoff is 30 days back; the 3rd page crosses it.
    const provider = new PagedProvider([
      [msg("30", NOW - 1 * DAY), msg("29", NOW - 2 * DAY)],
      [msg("20", NOW - 10 * DAY), msg("19", NOW - 20 * DAY)],
      [msg("10", NOW - 31 * DAY), msg("9", NOW - 40 * DAY)],
    ])
    const { engine, sent } = makeEngine(db, provider)
    engine.startBackfill({ days: 30 })
    await drain(engine)

    const status = engine.getBackfillStatus()
    expect(status.running).toBe(false)
    expect(status.conversationsDone).toBe(1)
    // Stopped once the oldest ts crossed the cutoff — the 3rd page did it.
    expect(status.messagesFetched).toBe(6)
    // Progress was broadcast.
    expect(sent.some((m) => m.type === "backfill-progress")).toBe(true)
    // All fetched messages are in the store.
    expect(listMessages(db, SERVICE, "c", { limit: 100 }).length).toBe(6)
  })

  test("stops when the cursor runs out before the cutoff", async () => {
    const provider = new PagedProvider([
      [msg("2", NOW - 1 * DAY)],
      [msg("1", NOW - 2 * DAY)], // still within 30 days; cursor ends here
    ])
    const { engine } = makeEngine(db, provider)
    engine.startBackfill({ days: 30 })
    await drain(engine)
    expect(engine.getBackfillStatus().messagesFetched).toBe(2)
  })

  test("resumable — a restart continues from the stored cursor", async () => {
    // First run aborts mid-conversation via a 429 on page 2, leaving a persisted cursor.
    const p1 = new PagedProvider([
      [msg("30", NOW - 1 * DAY)],
      [msg("20", NOW - 10 * DAY)],
      [msg("10", NOW - 40 * DAY)],
    ])
    p1.throwAtPage = 2
    const { engine: e1 } = makeEngine(db, p1)
    e1.startBackfill({ days: 30 })
    await drain(e1)
    expect(e1.getBackfillStatus().error).toBe("rate_limited")
    // Page 1 stored; a resume cursor is persisted (pointing at page 1 = the next unfetched page).
    expect(getBackfillCursor(db, SERVICE, "c")).toBe("1")

    // Second run (fresh engine, same db) resumes from cursor "1" — it must NOT re-fetch page 0.
    const p2 = new PagedProvider([
      [msg("30", NOW - 1 * DAY)],
      [msg("20", NOW - 10 * DAY)],
      [msg("10", NOW - 40 * DAY)],
    ])
    const { engine: e2 } = makeEngine(db, p2)
    e2.startBackfill({ days: 30 })
    await drain(e2)
    // Resumed at page 1, fetched pages 1 + 2 (2 messages), then crossed the cutoff.
    expect(p2.calls).toBe(2)
    expect(getBackfillCursor(db, SERVICE, "c")).toBeNull() // cleared on completion
  })

  test("single-flight — a second start while running is a no-op", async () => {
    const provider = new PagedProvider([[msg("1", NOW - 1 * DAY)]])
    // Make the run hang on the first page delay so it stays 'running'.
    let release: () => void = () => {}
    const engine = createBackfillEngine({
      db,
      provider: provider.provider,
      service: SERVICE,
      broadcast: () => {},
      sleep: () => new Promise<void>((r) => (release = r)),
      now: () => NOW,
    })
    const first = engine.startBackfill({ days: 30 })
    expect(first.running).toBe(true)
    // fetchHistory for the single page returns cursor null → stops without sleeping; guard anyway.
    const second = engine.startBackfill({ days: 30 })
    expect(second.running).toBe(true)
    expect(provider.calls).toBeLessThanOrEqual(1)
    release()
    await drain(engine)
  })

  test("429 storm aborts: status.error set, running false, health broadcast", async () => {
    const provider = new PagedProvider([[msg("1", NOW - 1 * DAY)]])
    provider.throwAtPage = 1
    const { engine, sent } = makeEngine(db, provider)
    engine.startBackfill({ days: 30 })
    await drain(engine)
    const status = engine.getBackfillStatus()
    expect(status.running).toBe(false)
    expect(status.error).toBe("rate_limited")
    expect(sent.some((m) => m.type === "health" && m.ok === false)).toBe(true)
  })
})
