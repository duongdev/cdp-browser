// The backfill engine (PSN-93, Workstream D). A manual, deep history fetch (decision 7): page each
// conversation's history BACKWARD via the provider cursor until a message ts crosses the cutoff
// (now − days) or the cursor runs out. Serial per conversation with a small inter-page delay
// (rate-limit-aware); resumable — the per-conversation cursor is persisted so a restart mid-run
// continues instead of re-paging from the top.
//
// Pure paging logic lives in backfill-plan.ts (shouldStopBackfill / cutoffFor). This runner owns the
// I/O, the single-flight status, progress broadcasts, and the 429 abort.

import type BetterSqlite3 from "better-sqlite3"
import { cutoffFor, pageOldestTs, shouldStopBackfill } from "./backfill-plan.ts"
import type { BackfillStatus, ChatService, ChatWsServerMessage } from "./contract.ts"
import type { ChatProvider } from "./providers/provider.ts"
import { ProviderError } from "./providers/provider.ts"
import * as store from "./store.ts"
import { toMessageInput } from "./upsert-map.ts"

type Db = BetterSqlite3.Database

export const DEFAULT_DAYS = 30
export const PAGE_DELAY_MS = 400

export interface BackfillDeps {
  db: Db
  provider: ChatProvider
  service: ChatService
  broadcast: (msg: ChatWsServerMessage) => void
  /** Injected delay so tests don't wait real time. Defaults to a real setTimeout. */
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  pageDelayMs?: number
}

export interface BackfillEngine {
  /** Start (or no-op if already running) a run over the last `days`. Returns the current status. */
  startBackfill(opts: { days?: number }): BackfillStatus
  getBackfillStatus(): BackfillStatus
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export function createBackfillEngine(deps: BackfillDeps): BackfillEngine {
  const { db, provider, service, broadcast } = deps
  const sleep = deps.sleep ?? realSleep
  const now = deps.now ?? Date.now
  const pageDelayMs = deps.pageDelayMs ?? PAGE_DELAY_MS

  let status: BackfillStatus = {
    running: false,
    days: DEFAULT_DAYS,
    conversationsDone: 0,
    conversationsTotal: 0,
    messagesFetched: 0,
  }

  function emit(): void {
    broadcast({ type: "backfill-progress", service, status: { ...status } })
  }

  async function run(days: number): Promise<void> {
    const cutoff = cutoffFor(now(), days)
    // The list may have grown since; snapshot the work list once at the start of the run.
    const convIds = store.listConversationIds(db, service)
    status = {
      running: true,
      days,
      conversationsDone: 0,
      conversationsTotal: convIds.length,
      messagesFetched: 0,
      error: undefined,
    }
    emit()

    try {
      for (const convId of convIds) {
        await backfillConversation(convId, cutoff)
        status = { ...status, conversationsDone: status.conversationsDone + 1 }
        emit()
      }
      status = { ...status, running: false }
      emit()
    } catch (err) {
      // A 429 storm (or any provider failure) aborts cleanly: honest error, running:false, health.
      const code = err instanceof ProviderError ? err.code : "backfill_error"
      status = { ...status, running: false, error: code }
      broadcast({ type: "health", service, ok: false, code })
      emit()
    }
  }

  async function backfillConversation(convId: string, cutoff: number): Promise<void> {
    // Resume from a persisted cursor if a prior run was interrupted mid-conversation.
    let cursor: string | null = store.getBackfillCursor(db, service, convId)
    // Guard runaway loops on a provider that never returns a null cursor / never crosses the cutoff.
    let pages = 0
    const MAX_PAGES = 1000 // ponytail: hard page ceiling per conv, raise if a real thread exceeds it
    while (pages < MAX_PAGES) {
      pages++
      const page = await provider.fetchHistory(convId, cursor, false)
      store.upsertMessages(db, service, convId, page.messages.map(toMessageInput))
      status = { ...status, messagesFetched: status.messagesFetched + page.messages.length }
      const oldest = pageOldestTs(page.messages)
      cursor = page.cursor
      // Persist progress so a restart resumes here (cleared when the conversation finishes).
      store.setBackfillCursor(db, service, convId, cursor)
      if (shouldStopBackfill(oldest, cutoff, cursor)) break
      emit()
      await sleep(pageDelayMs)
    }
    store.setBackfillCursor(db, service, convId, null)
  }

  return {
    startBackfill(opts) {
      const days =
        Number.isFinite(opts?.days) && (opts.days as number) > 0
          ? (opts.days as number)
          : DEFAULT_DAYS
      if (status.running) return { ...status } // single-flight: a second start is a no-op
      // Fire and forget — the run drives progress via broadcast; errors are captured into status.
      void run(days)
      return { ...status }
    },
    getBackfillStatus: () => ({ ...status }),
  }
}
