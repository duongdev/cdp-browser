// Pure one-frame-in-flight ack gate (t056). On the web path a supporting client acks a
// Screencast Frame only *after* it paints it; the server holds the next frame for that
// client until the ack lands, so at most one frame is ever outstanding instead of an
// unbounded backlog piling up on a slow link (stale-frame backlog = the perceived lag).
//
// The gate is the pure core of that rule: `mayProceed()` is true only when nothing is
// outstanding; `markSent(id)` records a frame went to the client; `ackReceived(id)` clears
// it when the client's `Page.screencastFrameAck` arrives. `reset()` (Downlink close /
// reconnect) frees the slot so the next frame is immediately eligible.
//
// Coalesce-to-latest, not queue: a frame arriving while one is outstanding is dropped by
// the caller's throttle, and a fresh `markSent` only tracks the latest id — the client
// always sees the freshest frame, never a replayed stale one. An ack whose id isn't the
// outstanding one (a stale retry, or an ack with nothing outstanding) is a no-op, so the
// slot is never freed twice or pushed negative.
//
// No timers/DOM/sockets — the server owns the watchdog that re-acks on a stranded paint
// (a dropped/hidden client) by reading `outstanding()`. CommonJS so web/server.mjs imports
// it by path (ADR-0008 shared-CJS core). Tested by frame-ack-gate.test.ts.

function createAckGate() {
  // The session id of the frame currently awaiting its client ack, or null when idle.
  let pending = null

  return {
    mayProceed() {
      return pending === null
    },
    markSent(sessionId) {
      // Coalesce-to-latest: track only the most recent frame handed to the client.
      pending = sessionId
    },
    ackReceived(sessionId) {
      // Only the outstanding frame's ack frees the slot — a stale/duplicate ack is ignored.
      if (pending !== null && sessionId === pending) pending = null
    },
    reset() {
      pending = null
    },
    outstanding() {
      return pending
    },
  }
}

module.exports = { createAckGate }
