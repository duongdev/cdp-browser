/**
 * Generic command batcher for the web transport. Without a WebSocket, each CDP
 * command would otherwise be one HTTP POST — a storm under mouse-move/wheel and
 * the per-frame `screencastFrameAck`. This coalesces high-frequency commands onto
 * a scheduler (a rAF flush in production) into a single POST per frame, while
 * discrete commands (click, key) flush the pending batch first and then send
 * immediately, so ordering is preserved. Each batch carries a monotonic `seq` so
 * the server applies them in order.
 *
 * Agnostic of the item type and of the DOM/timers: the caller classifies each
 * command (coalesce / append / immediate) and injects the scheduler and sender,
 * which is how it's unit-tested. See docs/tasks/008.
 */

export interface Batch<T> {
  seq: number
  items: T[]
}

export interface BatcherDeps<T> {
  /** Arrange a single future flush (production: requestAnimationFrame). */
  schedule: (flush: () => void) => void
  /** Deliver one batch (production: POST /api/cdp-batch). */
  send: (batch: Batch<T>) => void
}

interface Slot<T> {
  item: T
  coalesceable: boolean
}

export function createBatcher<T>({ schedule, send }: BatcherDeps<T>) {
  let queue: Slot<T>[] = []
  let seq = 0
  let scheduled = false

  function flush() {
    scheduled = false
    if (queue.length === 0) return
    send({ seq: seq++, items: queue.map((s) => s.item) })
    queue = []
  }

  function ensureScheduled() {
    if (scheduled) return
    scheduled = true
    schedule(flush)
  }

  return {
    /** Only the latest coalesced item survives; appended items are untouched. */
    coalesce(item: T) {
      queue = queue.filter((s) => !s.coalesceable)
      queue.push({ item, coalesceable: true })
      ensureScheduled()
    },
    /** Accumulate — must not be dropped (e.g. wheel deltas). */
    append(item: T) {
      queue.push({ item, coalesceable: false })
      ensureScheduled()
    },
    /** Discrete command: flush the pending batch, then send this one alone. */
    immediate(item: T) {
      flush()
      send({ seq: seq++, items: [item] })
    },
    flush,
  }
}
