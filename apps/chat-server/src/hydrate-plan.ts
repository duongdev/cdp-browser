// Pure hydrate planner (PSN-115 WS-B). No I/O — the effectful engine (hydrate.ts) owns fetch + store.
// Given a substrate search hit and whether that hit's message is already in chat.db, decide whether
// to fetch the conversation window around the hit. Kept pure so the skip/fetch decision is unit-
// testable without a provider or DB.

import type { ProviderSearchHit } from "./providers/provider.ts"

/** A hydrate window shouldn't need more than a handful of backward pages — the hit's message sits
 *  near the newest page of its conversation in the common case. Raise this ceiling if a real
 *  conversation ever needs more; the runner is the bound, not the truth. */
export const MAX_HYDRATE_PAGES = 5

export type HydratePlan =
  | { action: "skip" }
  | { action: "fetch"; convId: string; aroundMsgId: string }

/** Skip when the hit's message is already in chat.db (idempotent fast path); otherwise fetch the
 *  conversation window around `hit.msgId`. `exists` is passed in (not read from DB) to keep this
 *  pure — the caller knows how to ask the store. */
export function planHydrate(hit: ProviderSearchHit, exists: boolean): HydratePlan {
  if (exists) return { action: "skip" }
  return { action: "fetch", convId: hit.convId, aroundMsgId: hit.msgId }
}
