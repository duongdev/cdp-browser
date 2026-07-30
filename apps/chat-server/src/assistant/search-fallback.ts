// The hybrid search data plane (PSN-115 WS-C, extracted for PSN-114). Local FTS fast path, then a
// substrate live fallback (provider.searchMessages) + hydrate-on-miss, then a re-query that merges
// hydrated rows + best-effort substrate-only rows. SHARED by the in-app assistant (loop.ts) and the
// MCP server (mcp.ts) so an MCP query reaches all Teams history, not just chat.db — one
// orchestration, two adapters (D10). Per-consumer concerns (the assistant's onSurfaced citation
// tracking; the MCP return shape) stay in the callers (D9).

import type BetterSqlite3 from "better-sqlite3"
import type { HydrateEngine } from "../hydrate.ts"
import type { ChatProvider, ProviderSearchHit } from "../providers/provider.ts"
import { type SearchHit, searchMessages } from "../search.ts"

type Db = BetterSqlite3.Database

/** How long the search waits for the hydrate pipeline to land substrate rows in chat.db before
 *  re-querying. A slow keeper tab can't stall the turn; substrate-only rows ship best-effort. */
export const HYDRATE_WAIT_MS = 3000

/** When wired, the search falls back to the provider's substrate search + hydrate pipeline on a
 *  thin/zero local page. Either field without the other is meaningless, so they travel as a pair. */
export interface SearchFallback {
  provider: ChatProvider
  hydrate: HydrateEngine
}

/** Tool-input shape (the non-service subset of SearchOpts). */
export interface SearchInput {
  query: string
  sender?: string
  convId?: string
  convIds?: string[]
  after?: number
  before?: number
  mentionsMe?: boolean
  limit?: number
}

/** Compact row shape both adapters ship. Pure local FTS hit → row (via hitRow); a substrate-only
 *  row is the same shape with `substrate:true` and a preview snippet. */
export interface SearchRow {
  convId: string
  msgId: string
  sender: string
  ts: number | null
  snippet: string
  /** Local FTS only — the quoted parent the message replies to. Absent on substrate-only rows. */
  repliesTo?: SearchHit["quotes"]
  /** Local FTS only — inline images + transcriptions. Absent on substrate-only rows. */
  images?: SearchHit["images"]
  /** True when the row came from substrate but didn't hydrate in time (a preview, not full text). */
  substrate?: boolean
}

/** Local FTS hit → the compact row shape. Pure, shared by the fast + fallback paths so the row
 *  shape never drifts between them. */
export function hitRow(h: SearchHit): SearchRow {
  return {
    convId: h.convId,
    msgId: h.msgId,
    sender: h.senderName || h.senderId || "?",
    ts: h.ts,
    snippet: h.snippet,
    ...(h.quotes?.length ? { repliesTo: h.quotes } : {}),
    ...(h.images?.length ? { images: h.images } : {}),
  }
}

export interface SearchResult {
  rows: SearchRow[]
  /** True when the substrate path actually ran (the early local-only return was skipped). Callers
   *  that distinguish a bare-array fast-path return from an `{rows}` fallback return key off this. */
  fallbackRan: boolean
  /** True when substrate threw (auth/rate-limit/shape drift) — rows are local-only, `note` explains. */
  degraded?: boolean
  note?: string
}

/** Run a hybrid search. Pure-ish: takes the db + optional provider/hydrate, returns rows + flags.
 *  No onSurfaced — callers that need citation tracking walk `rows` themselves. */
export async function runSearch(
  db: Db,
  service: string,
  input: SearchInput,
  search?: SearchFallback,
): Promise<SearchResult> {
  const limit = input.limit ?? 20
  const localHits = searchMessages(db, { ...input, service, limit })

  // Fast path: no substrate search wired, or local FTS already filled the page.
  if (!search || localHits.length >= limit) {
    return { rows: localHits.map(hitRow), fallbackRan: false }
  }

  // Thin/zero local → one substrate call. A failure degrades honestly to local-only.
  let substrateHits: ProviderSearchHit[] = []
  try {
    const page = await search.provider.searchMessages(input.query, { sort: "relevance" })
    substrateHits = page.rows
  } catch {
    return {
      rows: localHits.map(hitRow),
      fallbackRan: true,
      degraded: true,
      note: "upstream search unavailable; showing synced results only",
    }
  }

  // Hydrate substrate hits not local yet, bounded by HYDRATE_WAIT_MS, then re-query so the model
  // sees real rows (full snippet + sender id + FTS relevance).
  const have = new Set(localHits.map((h) => `${h.convId}\n${h.msgId}`))
  const missing = substrateHits.filter((h) => !have.has(`${h.convId}\n${h.msgId}`))
  if (missing.length) {
    await Promise.race([
      search.hydrate.hydrateHits(missing).catch(() => {}),
      new Promise<void>((r) => setTimeout(r, HYDRATE_WAIT_MS)),
    ])
  }

  // Re-query on the same filters; widen the net so freshly-hydrated rows beyond the original limit
  // still surface (relevance order keeps the best ones on top).
  const reLocal = searchMessages(db, { ...input, service, limit: Math.max(limit, 20) })
  const reHave = new Set(reLocal.map((h) => `${h.convId}\n${h.msgId}`))
  const rows: SearchRow[] = reLocal.map(hitRow)
  // Substrate-only rows (didn't hydrate in time) still go in — marked `substrate:true` so the caller
  // knows it's a preview.
  for (const h of substrateHits) {
    if (rows.length >= limit) break
    if (reHave.has(`${h.convId}\n${h.msgId}`)) continue
    rows.push({
      convId: h.convId,
      msgId: h.msgId,
      sender: h.sender,
      ts: h.ts,
      snippet: h.preview,
      substrate: true,
    })
  }
  return { rows: rows.slice(0, limit), fallbackRan: true }
}
