// Pure helpers for the sync-log diagnostics (Workstream D). No I/O — all functions are
// deterministic on their inputs so they can be tested without a server.

/** Mirrors the BFF's `SyncEvent` (apps/chat-server/src/sweep.ts). `list` is the service-level lane —
 *  its failure means the service is down. `focus` is one conversation's own sync; it can fail on its
 *  own (a stale/deleted conv id) without the service being unhealthy, so it carries the `convId`. */
export interface SyncEvent {
  kind: "list" | "focus"
  ts: number
  ok: boolean
  code?: string
  convId?: string
}

/** Row label for the Sync card — a per-conversation event names its conversation. */
export function syncEventLabel(event: SyncEvent): string {
  if (event.kind !== "focus" || !event.convId) return event.kind
  return `focus · ${shortConvId(event.convId)}`
}

/** Teams conv ids are long (`19:abc…@thread.v2`); show enough to tell two apart. */
function shortConvId(convId: string): string {
  const core = convId.replace(/^\d+:/, "").replace(/@.*$/, "")
  return core.length > 12 ? `${core.slice(0, 12)}…` : core
}

export interface SyncLogData {
  lastHealthOk: number | null
  lastError: number | null
  lastErrorCode?: string
  events: SyncEvent[]
}

/** Human-readable relative time for a timestamp, relative to `now`. */
export function formatRelativeTime(ts: number, now: number): string {
  const diffMs = now - ts
  const diffSec = Math.floor(diffMs / 1000)
  if (diffSec < 5) return "just now"
  if (diffSec < 60) return `${diffSec}s ago`
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHour = Math.floor(diffMin / 60)
  if (diffHour < 24) return `${diffHour}h ago`
  const diffDay = Math.floor(diffHour / 24)
  return `${diffDay}d ago`
}
