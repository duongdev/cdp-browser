// Pure helpers for the sync-log diagnostics (Workstream D). No I/O — all functions are
// deterministic on their inputs so they can be tested without a server.

export interface SyncEvent {
  kind: string
  ts: number
  ok: boolean
  code?: string
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
