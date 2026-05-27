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

export interface SingleFlightDeps<T> {
  /** Deliver one merged batch and resolve when the transport has accepted it. */
  post: (items: T[]) => Promise<unknown>
  /** Collapse the accumulated items before a flight (e.g. drop superseded moves). */
  merge: (items: T[]) => T[]
}

/**
 * Request-level backpressure for a transport that has no persistent channel: at most
 * one `post` is in flight at a time. Items pushed while a post is outstanding accumulate
 * and, when it settles, are `merge`d into a single next post. This bounds the request
 * rate to the link's round-trip — a fast link drains often, a slow one batches more —
 * instead of flooding fire-and-forget requests that serialize and back up. Resolving on
 * both fulfilment and rejection means a failed post never wedges the queue.
 *
 * Used by the web build's POST fallback when the streaming input channel can't activate.
 */
export function createSingleFlight<T>({ post, merge }: SingleFlightDeps<T>) {
  let pending: T[] = []
  let inFlight = false

  function pump() {
    if (inFlight || pending.length === 0) return
    const items = merge(pending)
    pending = []
    inFlight = true
    post(items).then(done, done)
  }
  function done() {
    inFlight = false
    pump()
  }

  return {
    push(items: T[]) {
      pending.push(...items)
      pump()
    },
  }
}

export interface HoverGateDeps<T> {
  /** Arm the "movement stopped" timer; returns a cancel fn (production: setTimeout). */
  delay: (cb: () => void) => () => void
  /** Emit the resting position once movement stops (production: batcher.coalesce). */
  emit: (item: T) => void
}

/**
 * Throttle buttons-up (hover) moves to one emit per *rest*: each move re-arms a stop
 * timer and only the latest position is emitted once the cursor goes still. A press,
 * release, or drag must call `cancel()` — its own coordinates supersede the held hover,
 * and a stale resting move firing after a click would yank the cursor backwards.
 *
 * This is what keeps the no-WebSocket web build responsive: a continuous hover no longer
 * produces ~60 commands/sec (which backs up the POST fallback and delays clicks); it
 * produces one when you stop. Drag moves bypass the gate so drag-select / drag-n-drop
 * still track live.
 */
export function createHoverGate<T>({ delay, emit }: HoverGateDeps<T>) {
  let pending: T | null = null
  let cancelTimer: (() => void) | null = null

  return {
    move(item: T) {
      pending = item
      cancelTimer?.()
      cancelTimer = delay(() => {
        cancelTimer = null
        if (pending !== null) {
          const p = pending
          pending = null
          emit(p)
        }
      })
    },
    cancel() {
      cancelTimer?.()
      cancelTimer = null
      pending = null
    },
  }
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
