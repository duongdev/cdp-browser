// Local edit/delete history (PSN-105, Workstream C). Teams exposes NO previous version of a message
// — only an `edittime` stamp and the current body — so the only place a prior body can be preserved
// is the instant before `upsertMessages` overwrites it. This module is the PURE decision: given the
// row we already have and the row that just arrived, is there an old body worth keeping?
//
// Ceiling, stated plainly: only changes this BFF observes are recorded. An edit made before the
// feature shipped, or while the server was down, is unrecoverable.

/** Versions kept per message (R3 — a chatty edited thread would otherwise grow forever). The UI
 *  says so when it is hit; silent truncation is not allowed. */
export const MAX_VERSIONS_PER_MESSAGE = 20

/** What the store already holds for a message. */
export interface PrevBody {
  body: string
  deleted: boolean
}

/** What just arrived from the provider. */
export interface NextBody {
  body?: string
  deleted?: boolean
  /** The provider's edit timestamp (epoch ms) for the change that supersedes the old body. */
  editTs?: number | null
}

/** One superseded body to persist. `editTs` is when the replacement landed — the popover's label. */
export interface EditSnapshot {
  body: string
  editTs: number
}

/**
 * The old body worth snapshotting, or null when nothing changed.
 *
 * Snapshots on two events only: the body text changed, or the message flipped to deleted (whose
 * incoming body is a tombstone placeholder, so the real text only exists in the stored row).
 * A first sight of a message, an unchanged re-sweep, an empty incoming body on a live message
 * (a partial payload, never a real edit — see `resolveBody`, which refuses to persist it either)
 * and an already-deleted row all return null.
 *
 * A delete is stamped with `now`, never the provider's `edittime`: a tombstone that was edited
 * before it was removed still carries the OLD edit stamp, which would date the delete to when that
 * body was written (PSN-105 QE DEF-2). `editTs` only labels a body-for-body replacement.
 */
export function planSnapshot(
  prev: PrevBody | null | undefined,
  next: NextBody,
  now: number,
): EditSnapshot | null {
  if (!prev) return null
  const old = prev.body || ""
  if (!old.trim()) return null
  if (prev.deleted) return null
  if (next.deleted) return { body: old, editTs: now }
  const incoming = next.body || ""
  if (!incoming.trim()) return null
  if (incoming === old) return null
  const stamp =
    Number.isFinite(next.editTs) && (next.editTs as number) > 0 ? Number(next.editTs) : now
  return { body: old, editTs: stamp }
}

/**
 * The body to actually persist — the write-side half of the same distrust `planSnapshot` applies.
 *
 * A blank incoming body on a LIVE message that already holds real text is a partial payload, not an
 * edit, so the stored text is kept. Without this the guard protected only the snapshot while the
 * write went through anyway, and a blank payload erased the message from both the row and its
 * history (PSN-105 QE DEF-1 — the one case the code distrusts was the one that destroyed data).
 *
 * A delete is the legitimate blanking path and always wins: providers differ on the tombstone body
 * (real Teams sends "message deleted", the mock sends ""), and both must land as-is.
 */
export function resolveBody(prev: PrevBody | null | undefined, next: NextBody): string {
  const incoming = next.body || ""
  if (next.deleted) return incoming
  if (incoming.trim()) return incoming
  const old = prev?.body || ""
  if (!prev || prev.deleted || !old.trim()) return incoming
  return old
}
