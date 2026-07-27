// Compaction policy (t173, ADR-0021 decision 4): what's SENT shrinks, what's STORED never does.
// When the projected prompt exceeds the token budget, older messages summarize into
// `ai_sessions.summary` and `summary_upto_idx` advances; rows are never deleted. Pure policy —
// the summarize call is the caller's effect.

import type { StoredUIMessage } from "./session-store.ts"

/** ~4 chars per token — reconciled against real `usage` accumulated into total_tokens. */
export function estimateTokens(text: string): number {
  return Math.ceil((text || "").length / 4)
}

export function messageChars(msg: StoredUIMessage): number {
  let n = 0
  for (const part of msg.parts || []) {
    const p = part as { type?: string; text?: string; output?: unknown; input?: unknown }
    if (typeof p?.text === "string") n += p.text.length
    if (p?.output !== undefined) n += JSON.stringify(p.output)?.length || 0
    if (p?.input !== undefined) n += JSON.stringify(p.input)?.length || 0
  }
  return n
}

export const COMPACT_THRESHOLD_TOKENS = 40_000
/** Never summarize away the newest turns — the model needs verbatim recency. */
export const KEEP_RECENT_MESSAGES = 8

export interface CompactionPlan {
  needed: boolean
  /** Summarize messages with idx in [fromIdx, uptoIdx); new summary_upto_idx = uptoIdx. */
  fromIdx: number
  uptoIdx: number
}

/** Decide whether (and how far) to compact. `messages` is the FULL stored list in idx order;
 *  `summaryUptoIdx` is the current watermark (messages below it are already summarized). */
export function planCompaction(
  messages: StoredUIMessage[],
  summaryUptoIdx: number,
  summary: string | null,
  threshold: number = COMPACT_THRESHOLD_TOKENS,
): CompactionPlan {
  const live = messages.slice(summaryUptoIdx)
  const liveChars = live.reduce((n, m) => n + messageChars(m), 0)
  const projected = Math.ceil(liveChars / 4) + estimateTokens(summary || "")
  const none: CompactionPlan = { needed: false, fromIdx: summaryUptoIdx, uptoIdx: summaryUptoIdx }
  if (projected <= threshold) return none
  const uptoIdx = Math.max(summaryUptoIdx, messages.length - KEEP_RECENT_MESSAGES)
  if (uptoIdx <= summaryUptoIdx) return none
  return { needed: true, fromIdx: summaryUptoIdx, uptoIdx }
}

/** Plain-text rendering of the messages a summarize call condenses. */
export function transcriptForSummary(messages: StoredUIMessage[]): string {
  const lines: string[] = []
  for (const msg of messages) {
    const texts = (msg.parts || [])
      .map((p) => (p as { text?: string })?.text)
      .filter((t): t is string => typeof t === "string" && !!t.trim())
    if (texts.length) lines.push(`${msg.role}: ${texts.join(" ")}`)
  }
  return lines.join("\n")
}
