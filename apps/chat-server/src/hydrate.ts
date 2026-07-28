// Hydrate engine (PSN-115 WS-B). Given a substrate search hit whose message isn't in chat.db, fetch
// that conversation's window around the hit's msgId and upsert it into the DB — which also syncs the
// FTS shadow index, so WS-D's local re-query finds the newly-hydrated term. Idempotent: a hit whose
// message already exists is a no-op. Single-flight per conv: two concurrent hydrates for the same
// conv share one fetch pass. Bounded pages (MAX_HYDRATE_PAGES), 429/auth-aware (mirrors backfill's
// discipline). Never throws — R4 best-effort: a miss that can't be hydrated renders the substrate
// preview (the FE shows `missing` on jump), never a crash.

import type BetterSqlite3 from "better-sqlite3"
import type { ChatService, ChatWsServerMessage, HistoryPage } from "./contract.ts"
import { MAX_HYDRATE_PAGES } from "./hydrate-plan.ts"
import type { ChatProvider, ProviderSearchHit } from "./providers/provider.ts"
import { ProviderError } from "./providers/provider.ts"
import * as store from "./store.ts"
import { toMessageInput } from "./upsert-map.ts"

type Db = BetterSqlite3.Database

export const PAGE_DELAY_MS = 400

export type HydrateReason =
  | "already_present"
  | "fetched"
  | "not_found_upstream"
  | "rate_limited"
  | "auth"

export interface HydrateResult {
  hydrated: boolean
  reason?: HydrateReason
}

export interface HydrateDeps {
  db: Db
  provider: ChatProvider
  service: ChatService
  /** Optional WS broadcast — the existing `messages-upsert` delta fires from inside `upsertMessages`,
   *  so this is unused today but kept here so a future `hydrate-progress` frame (per the plan's
   *  optional add) is a one-line change. */
  broadcast?: (msg: ChatWsServerMessage) => void
  /** Injected so tests don't wait real time. Defaults to a real setTimeout. */
  sleep?: (ms: number) => Promise<void>
  pageDelayMs?: number
}

export interface HydrateEngine {
  hydrateHit(hit: ProviderSearchHit): Promise<HydrateResult>
  /** Batch entry for WS-D's background hydrate-on-render. Single-flight per conv, so N hits in the
   *  same conversation issue ONE fetch pass (the first miss triggers it; later hits await the same
   *  promise and re-check the DB, where the now-hydrated message short-circuits). */
  hydrateHits(hits: ProviderSearchHit[]): Promise<HydrateResult[]>
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export function createHydrateEngine(deps: HydrateDeps): HydrateEngine {
  const { db, provider, service } = deps
  const sleep = deps.sleep ?? realSleep
  const pageDelayMs = deps.pageDelayMs ?? PAGE_DELAY_MS
  // ponytail: a plain Map<string, Promise> is enough — single-flight is per-process and the sweep is
  // the only other caller of fetchHistory; if a real contention pattern emerges, switch to a keyed
  // mutex with per-key queueing.
  const inFlight = new Map<string, Promise<HydrateResult>>()

  async function fetchWindow(convId: string, aroundMsgId: string): Promise<HydrateResult> {
    let cursor: string | null = null
    for (let page = 0; page < MAX_HYDRATE_PAGES; page++) {
      let pageResult: HistoryPage
      try {
        pageResult = await provider.fetchHistory(convId, cursor, false)
      } catch (err) {
        // R4 best-effort: a 429/auth blip is reported, not thrown. Other errors are reported as
        // not_found_upstream — the substrate preview still renders.
        if (err instanceof ProviderError) {
          const code: HydrateReason = err.code === "rate_limited" ? "rate_limited" : "auth"
          return { hydrated: false, reason: code }
        }
        return { hydrated: false, reason: "not_found_upstream" }
      }
      const { messages, cursor: nextCursor } = pageResult
      if (messages.length) {
        store.upsertMessages(db, service, convId, messages.map(toMessageInput))
      }
      if (messages.some((m) => String(m.id) === aroundMsgId)) {
        return { hydrated: true, reason: "fetched" }
      }
      cursor = nextCursor
      if (cursor == null) break
      await sleep(pageDelayMs)
    }
    return { hydrated: false, reason: "not_found_upstream" }
  }

  async function hydrateHit(hit: ProviderSearchHit): Promise<HydrateResult> {
    // Fast path: idempotent — if our hit's message is already in DB, skip the coordinator entirely.
    // (Also the correct outcome when an in-flight pass that we didn't join has just settled.)
    if (store.hasMessage(db, service, hit.convId, hit.msgId)) {
      return { hydrated: false, reason: "already_present" }
    }

    // Single-flight per conv. fetchHistory always starts from the newest page and pages backward,
    // so two calls for the same conv produce the same window — there's no value in a second pass
    // when the first finished without our msgId. Join the in-flight promise and report against the
    // shared result (re-checking the DB once it settles tells us whether OUR message landed).
    const existing = inFlight.get(hit.convId)
    if (existing) {
      await existing.catch(() => {})
      if (store.hasMessage(db, service, hit.convId, hit.msgId)) {
        return { hydrated: false, reason: "already_present" }
      }
      // Shared pass didn't reach our hit's msgId. The same windowed fetch wouldn't find it either,
      // so report an honest not_found_upstream rather than re-issuing identical work.
      return { hydrated: false, reason: "not_found_upstream" }
    }

    const p = fetchWindow(hit.convId, hit.msgId).finally(() => inFlight.delete(hit.convId))
    inFlight.set(hit.convId, p)
    const result = await p
    // A concurrent waiter may have hydrated our hit as a side effect of the shared fetch window.
    if (!result.hydrated && store.hasMessage(db, service, hit.convId, hit.msgId)) {
      return { hydrated: false, reason: "already_present" }
    }
    return result
  }

  async function hydrateHits(hits: ProviderSearchHit[]): Promise<HydrateResult[]> {
    return Promise.all(hits.map((h) => hydrateHit(h)))
  }

  return { hydrateHit, hydrateHits }
}
