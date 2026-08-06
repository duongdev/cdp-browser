// Pure display decisions for the reply-suggestions strip (ADR-0027, PSN-143). Kept out of the
// component so the rules are testable without a DOM — the repo's TDD-on-pure-logic convention.

import type { ReplySuggestionBatch } from "./chat-client"

/** What the strip should render. The component maps this to markup and owns nothing else. */
export type StripMode =
  | { kind: "idle" } // nothing to show — the generate affordance lives in the composer toolbar
  | { kind: "batch"; texts: string[]; chosenIdx: number | null; stale: boolean; busy: boolean }
  | { kind: "busy" } // a request is in flight and there is nothing on screen yet
  | { kind: "error"; message: string }

export interface StripInput {
  batch: ReplySuggestionBatch | null
  pending: boolean
  error: string | null
  /** Newest message id in the thread; a batch written for an older one is stale. */
  latestMsgId: string | null
}

/**
 * A batch is stale when the thread has moved on since it was written.
 *
 * A manual generate has no `forMsgId` (it answers the thread, not a message), so it is never stale —
 * marking it stale the instant any message arrives would flag suggestions the user just asked for.
 */
export function isStale(batch: ReplySuggestionBatch | null, latestMsgId: string | null): boolean {
  if (!batch?.forMsgId || !latestMsgId) return false
  return batch.forMsgId !== latestMsgId
}

/**
 * Resolve what to render.
 *
 * Precedence is deliberate: an existing batch outranks both the spinner and the error. A user who
 * already has suggestions on screen and presses regenerate must keep the old ones visible while the
 * new batch is produced — blanking them means a failed regenerate costs him what he already had.
 */
export function stripMode(input: StripInput): StripMode {
  const texts = input.batch?.texts ?? []
  if (texts.length > 0) {
    return {
      kind: "batch",
      texts,
      chosenIdx: input.batch?.chosenIdx ?? null,
      stale: isStale(input.batch, input.latestMsgId),
      // A regenerate keeps the old batch on screen (see the doc comment), so the in-flight state
      // has to ride along on it — otherwise pressing regenerate shows no sign of working.
      busy: input.pending,
    }
  }
  if (input.error) return { kind: "error", message: input.error }
  if (input.pending) return { kind: "busy" }
  return { kind: "idle" }
}
