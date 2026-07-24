// Pure helpers for displaying backfill run status (PSN-93, Workstream H).
import type { BackfillStatus } from "../../../apps/chat-server/src/contract"

/** 0–100, clamped. Returns 0 when total is 0 (nothing to compute yet). */
export function progressPercent(done: number, total: number): number {
  if (total <= 0) return 0
  return Math.min(100, Math.max(0, Math.round((done / total) * 100)))
}

/** One-line human-readable status text. Empty string when nothing has run. */
export function progressLabel(status: BackfillStatus): string {
  if (status.error) return status.error
  if (!status.running && status.conversationsDone === 0 && status.messagesFetched === 0) return ""
  const { conversationsDone: done, conversationsTotal: total, messagesFetched: msgs } = status
  return `${done} / ${total} conversations · ${msgs} messages`
}
