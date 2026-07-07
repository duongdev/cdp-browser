// Pure predicates for the WS fan-out backpressure + liveness (t099). No sockets here — the
// caller reads `ws.bufferedAmount` and tracks pong timestamps, then applies these decisions.

// Drop this frame for a client whose send buffer is already backed up past the cap (a
// suspended/slow iPad) — fresh-frame-wins, never accrete a backlog into a half-open socket
// (which `ws.send` buffers without throwing). A non-positive cap disables skipping.
function shouldSkipClient(bufferedAmount, cap) {
  return cap > 0 && bufferedAmount > cap
}

// A client that produced no liveness signal (pong) within the deadline is dead and should be
// terminated + evicted — the only way a half-open socket (never throws on send) gets reaped.
// A missing lastSeenAt (never ponged) past the deadline counts as dead.
function isClientDead(lastSeenAt, now, deadlineMs) {
  return now - (lastSeenAt || 0) > deadlineMs
}

module.exports = { shouldSkipClient, isClientDead }
