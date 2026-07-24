// The sweep engine (PSN-93, Workstream D). Keeps the store fresh and pushes WS deltas with zero FE
// clients required (that is the point of a BFF — push still fires). Mirrors the slack-sweep split:
// the pure planner (sweep-plan.ts) decides deltas, this runner does the I/O + broadcast.
//
// Two lanes:
//   - LIST (~12s): newest conversations page → version-gated upsert → broadcast the rows that
//     actually changed + read-state moves.
//   - FOCUS (~4s): each focused conv's newest history page → upsert (keep raw) → broadcast changed
//     messages + a refreshed conv row.
//
// Health: a provider 401 / upstream-unreachable broadcasts `{health, ok:false, code}` instead of
// throwing or hot-looping; the next clean sweep recovers to `{ok:true}`. A sweep error never crashes
// the process — it is swallowed and surfaced as health.

import type BetterSqlite3 from "better-sqlite3"
import type { ChatService } from "./contract.ts"
import type { ChatProvider } from "./providers/provider.ts"
import { ProviderError } from "./providers/provider.ts"
import * as store from "./store.ts"
import { planConversationSweep, planMessageSweep } from "./sweep-plan.ts"
import { toConversationInput, toMessageInput } from "./upsert-map.ts"

type Db = BetterSqlite3.Database

export const LIST_SWEEP_MS = 12_000
export const FOCUS_SWEEP_MS = 4_000

/** Injected timer surface so tests drive fake timers. Defaults to the globals. */
export interface Timers {
  setInterval: (fn: () => void, ms: number) => { unref?: () => void }
  clearInterval: (h: unknown) => void
}

const realTimers: Timers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
}

export interface SweepDeps {
  db: Db
  provider: ChatProvider
  service: ChatService
  broadcast: (msg: import("./contract.ts").ChatWsServerMessage) => void
  getFocusedConvIds: () => string[]
  timers?: Timers
  listMs?: number
  focusMs?: number
  now?: () => number
}

export interface SweepEngine {
  start(): void
  stop(): void
  /** Run one list-lane pass now (tests + boot warm-up). */
  runListOnce(): Promise<void>
  /** Run one focus-lane pass now for the given conv ids. */
  runFocusOnce(convIds: string[]): Promise<void>
  /** The last health state — `null` until the first sweep runs. */
  health(): { ok: boolean; code?: string } | null
}

export function createSweepEngine(deps: SweepDeps): SweepEngine {
  const { db, provider, service, broadcast, getFocusedConvIds } = deps
  const timers = deps.timers ?? realTimers
  const listMs = deps.listMs ?? LIST_SWEEP_MS
  const focusMs = deps.focusMs ?? FOCUS_SWEEP_MS
  let lastHealthOk: boolean | null = null
  let listTimer: { unref?: () => void } | null = null
  let focusTimer: { unref?: () => void } | null = null

  // Broadcast a health flip only when it changes (no chatty repeats). A clean sweep recovers.
  function markHealthy(): void {
    if (lastHealthOk !== true) {
      lastHealthOk = true
      broadcast({ type: "health", service, ok: true })
    }
  }
  function markUnhealthy(code: string): void {
    // Always re-broadcast the failure (the code may change; FE shows the reconnecting banner) but
    // never loop hot — the interval itself paces retries.
    lastHealthOk = false
    broadcast({ type: "health", service, ok: false, code })
  }

  // A provider failure → a typed health code; anything else → "sweep_error". Never rethrows.
  function healthCodeOf(err: unknown): string {
    if (err instanceof ProviderError) return err.code
    return "sweep_error"
  }

  async function runListOnce(): Promise<void> {
    try {
      const prior = store.priorConversations(db, service)
      const page = await provider.listConversations(null)
      store.upsertConversations(db, service, page.conversations.map(toConversationInput))
      // Re-read the post-upsert view so broadcast rows carry the store's resolved readTs/mentionCount.
      const after = new Map(store.listConversations(db, service).map((c) => [c.id, c]))
      const { changedConversations, readStateChanges } = planConversationSweep(
        page.conversations,
        prior,
      )
      const rows = changedConversations.map((c) => after.get(c.id) ?? c)
      if (rows.length) broadcast({ type: "conversation-upsert", service, conversations: rows })
      for (const rs of readStateChanges) {
        broadcast({
          type: "read-state",
          service,
          convId: rs.convId,
          readTs: rs.readTs,
          unreadSticky: rs.unreadSticky,
        })
      }
      markHealthy()
    } catch (err) {
      markUnhealthy(healthCodeOf(err))
    }
  }

  async function refreshConvRow(convId: string): Promise<void> {
    const row = store.listConversations(db, service).find((c) => c.id === convId)
    if (row) broadcast({ type: "conversation-upsert", service, conversations: [row] })
  }

  async function runFocusOnce(convIds: string[]): Promise<void> {
    for (const convId of convIds) {
      try {
        const prior = store.priorMessages(db, service, convId)
        const beforeRead = store.getReadState(db, service, convId)
        const page = await provider.fetchHistory(convId, null, true)
        store.upsertMessages(db, service, convId, page.messages.map(toMessageInput))
        persistSenders(db, service, page.messages)
        const changed = planMessageSweep(page.messages, prior)
        if (changed.length)
          broadcast({ type: "messages-upsert", service, convId, messages: changed })
        // A focused fetch can shift the conv row (new last message) + read horizon.
        if (changed.length) await refreshConvRow(convId)
        const afterRead = store.getReadState(db, service, convId)
        if (readMoved(beforeRead, afterRead)) {
          const row = store.listConversations(db, service).find((c) => c.id === convId)
          if (row) {
            broadcast({
              type: "read-state",
              service,
              convId,
              readTs: row.readTs,
              unreadSticky: row.unreadSticky,
            })
          }
        }
        markHealthy()
      } catch (err) {
        markUnhealthy(healthCodeOf(err))
      }
    }
  }

  return {
    start() {
      if (listTimer || focusTimer) return
      listTimer = timers.setInterval(() => void runListOnce(), listMs)
      listTimer.unref?.()
      focusTimer = timers.setInterval(() => void runFocusOnce(getFocusedConvIds()), focusMs)
      focusTimer.unref?.()
    },
    stop() {
      if (listTimer) timers.clearInterval(listTimer)
      if (focusTimer) timers.clearInterval(focusTimer)
      listTimer = null
      focusTimer = null
    },
    runListOnce,
    runFocusOnce,
    health: () => (lastHealthOk == null ? null : { ok: lastHealthOk }),
  }
}

function readMoved(
  before: { readHorizonTs: number | null; localReadTs: number | null } | null,
  after: { readHorizonTs: number | null; localReadTs: number | null } | null,
): boolean {
  const b = before ?? { readHorizonTs: null, localReadTs: null }
  const a = after ?? { readHorizonTs: null, localReadTs: null }
  return b.readHorizonTs !== a.readHorizonTs || b.localReadTs !== a.localReadTs
}

// Cache sender display names off a history page (same as routes.ts) so later name lookups hit store.
function persistSenders(
  db: Db,
  service: string,
  messages: import("./contract.ts").ChatMessage[],
): void {
  const seen = new Map<string, string>()
  for (const m of messages) if (m.senderId && m.senderName) seen.set(m.senderId, m.senderName)
  if (seen.size)
    store.upsertUsers(
      db,
      service,
      [...seen].map(([id, displayName]) => ({ id, displayName })),
    )
}
