// Pure sweep planner (PSN-93, Workstream D). No I/O — the effectful sweep (sweep.ts) fetches fresh
// provider rows, reads the prior store rows, and asks this module WHAT changed. Mirrors the
// slack-sweep.js split: a pure reducer decides deltas, the runner does the I/O + broadcast.
//
// Version-gating + change-detection here so both are unit-testable in isolation. A conversation
// changes when its lastMessageVersion RISES (same discipline as store.upsertConversations' WHERE
// gate) — an equal or older version is a stale re-fetch and produces no delta. Messages change when
// a message is new, or its rendered body / edited / deleted / reaction signature differs. A
// read-state change is a readTs that moved (or the sticky flag flipping).

import type { ChatConversation, ChatMessage } from "./contract.ts"

// Prior-state maps are keyed by conversation/message id, so the value shapes carry no id field.

/** The prior store view a sweep diffs against — a subset of the fields that gate a delta. */
export interface PriorConversation {
  lastMessageVersion: number
  readTs: number
  unreadSticky: boolean
}

export interface PriorMessage {
  /** The rendered body last stored — a body change (edit) surfaces even at the same version. */
  body: string
  edited: boolean
  deleted: boolean
  /** A stable signature of the reaction buckets, so a reaction add/remove surfaces. */
  reactionSig: string
}

export interface ReadStateChange {
  convId: string
  readTs: number
  unreadSticky: boolean
}

export interface SweepPlan {
  /** Freshly-fetched conversation rows whose version actually rose (worth an upsert + broadcast). */
  changedConversations: ChatConversation[]
  /** Per conversation, the messages that are new or materially changed. */
  changedMessagesByConv: Record<string, ChatMessage[]>
  /** Conversations whose read watermark or sticky flag moved. */
  readStateChanges: ReadStateChange[]
}

/** A stable signature of a message's reactions — order-independent, so a re-ordered payload isn't a
 *  false change. `key:count:mine` per bucket, sorted. */
export function reactionSignature(msg: Pick<ChatMessage, "reactions">): string {
  const rs = msg.reactions
  if (!rs || rs.length === 0) return ""
  return rs
    .map((r) => `${r.key}:${r.count}:${r.mine ? 1 : 0}`)
    .sort()
    .join("|")
}

/** True when a fetched message differs from what the store holds (or is brand new). */
function messageChanged(fresh: ChatMessage, prior: PriorMessage | undefined): boolean {
  if (!prior) return true
  if ((fresh.body ?? "") !== prior.body) return true
  if (!!fresh.edited !== prior.edited) return true
  if (!!fresh.deleted !== prior.deleted) return true
  if (reactionSignature(fresh) !== prior.reactionSig) return true
  return false
}

/** Diff freshly-fetched conversation rows against the prior store view. Only rows whose version
 *  rose surface (stale/equal-version re-fetches produce nothing), plus any whose read watermark or
 *  sticky flag moved (read state can change without a new message). */
export function planConversationSweep(
  fresh: ChatConversation[],
  prior: Map<string, PriorConversation>,
): { changedConversations: ChatConversation[]; readStateChanges: ReadStateChange[] } {
  const changedConversations: ChatConversation[] = []
  const readStateChanges: ReadStateChange[] = []
  for (const c of fresh) {
    const p = prior.get(c.id)
    if (!p || c.lastMessageVersion > p.lastMessageVersion) changedConversations.push(c)
    if (!p || c.readTs !== p.readTs || !!c.unreadSticky !== p.unreadSticky) {
      readStateChanges.push({ convId: c.id, readTs: c.readTs, unreadSticky: !!c.unreadSticky })
    }
  }
  return { changedConversations, readStateChanges }
}

/** Diff a freshly-fetched history page against the prior stored messages for one conversation.
 *  Returns only the new/materially-changed messages (in fetch order). Empty when nothing moved. */
export function planMessageSweep(
  fresh: ChatMessage[],
  prior: Map<string, PriorMessage>,
): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const m of fresh) if (messageChanged(m, prior.get(m.id))) out.push(m)
  return out
}
