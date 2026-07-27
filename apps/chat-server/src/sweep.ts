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
import { buildPushPayload, type PushSender, shouldPush } from "./push.ts"
import * as store from "./store.ts"
import { planConversationSweep, planDeltaFetch, planMessageSweep } from "./sweep-plan.ts"
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
  /** Web push sender — fires on a genuinely new inbound last message (WS-G). Optional: absent → no
   *  push (tests, or a build with no VAPID). */
  pushSender?: PushSender
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
  const { db, provider, service, broadcast, getFocusedConvIds, pushSender } = deps
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
      // The BFF is the sole Teams push sender (WS-G): a genuinely new inbound last message pushes to
      // every stored sub with zero FE clients open. Use the post-upsert row (resolved readTs) and gate
      // per-conversation prefs; a cold-start conv (no prior) seeds silently.
      if (pushSender) await maybePush(rows, prior)
      for (const rs of readStateChanges) {
        // Use the post-upsert store row (bookmark-derived readTs + unreadSticky) — the provider row
        // has the raw Teams horizon and never sets unreadSticky, so it would clear the dot.
        const derived = after.get(rs.convId)
        broadcast({
          type: "read-state",
          service,
          convId: rs.convId,
          readTs: derived?.readTs ?? rs.readTs,
          unreadSticky: derived?.unreadSticky ?? rs.unreadSticky,
        })
      }
      markHealthy()
      // Push the actual MESSAGES of every conversation that changed, not just its row (PSN-106).
      // Without this a new message outside the one focused conversation reached the client only as a
      // version bump, so its thread stayed stale until a manual refetch. The focused convs keep their
      // own faster lane and are excluded. runFocusOnce swallows its own per-conv errors, so one bad
      // conversation can't take the list lane down with it.
      const { convIds, skipped } = planDeltaFetch(
        changedConversations.map((c) => c.id),
        getFocusedConvIds(),
      )
      if (skipped.length)
        console.warn(
          `[sweep] delta fan-out capped: fetched ${convIds.length}, deferred ${skipped.length} (${skipped.join(", ")})`,
        )
      if (convIds.length) await runFocusOnce(convIds)
    } catch (err) {
      markUnhealthy(healthCodeOf(err))
    }
  }

  // Fire a web push for each changed conversation whose new last message is genuinely inbound. The
  // conv row lacks the last message's sender name / mention flag, so read those from the store (synced
  // by the same upsert or a prior focus/backfill). A missing message → no sender + not-a-mention (a
  // muted+notifyOnMention conv then won't push, which is safe). Best-effort: a send never throws.
  async function maybePush(
    rows: import("./contract.ts").ChatConversation[],
    prior: Map<string, unknown>,
  ): Promise<void> {
    if (!pushSender) return
    for (const conv of rows) {
      const last = conv.lastMessageId
        ? store.getMessage(db, service, conv.id, conv.lastMessageId)
        : null
      const prefs = store.getPrefs(db, service, conv.id)
      if (!shouldPush(conv, prior.has(conv.id), prefs, !!last?.mentionsMe)) continue
      await pushSender.send(buildPushPayload(conv, last?.senderName ?? null))
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
        const page = await provider.fetchHistory(convId, null, true)
        store.upsertMessages(db, service, convId, page.messages.map(toMessageInput))
        persistSenders(db, service, page.messages)
        const changed = planMessageSweep(page.messages, prior)
        if (changed.length)
          broadcast({ type: "messages-upsert", service, convId, messages: changed })
        // A focused fetch can shift the conv row (a new last message). Read state is NOT touched
        // here (PSN-102) — it changes only on an explicit mark-read/unread or the list lane's
        // ingest of the service's own state, both of which broadcast their own `read-state`.
        if (changed.length) await refreshConvRow(convId)
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
