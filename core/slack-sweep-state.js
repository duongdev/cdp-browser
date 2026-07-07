// Persisted Slack sweep state (t099, ADR-0016). The per-workspace read watermark + the set of
// seeded teams are held in memory by web/server.mjs; persisting them means a server restart
// RESUMES from the watermark (backfilling the downtime gap through the sweep's history fetch)
// instead of re-seeding from `latest`, which silently drops every message that arrived while
// the server was down. Non-secret metadata only (channel ids + message timestamps).

// In-memory { watermark, seeded:Set } -> on-disk { watermark, seeded:[] }.
function serialize(state) {
  return {
    watermark: (state && state.watermark) || {},
    seeded: [...((state && state.seeded) || [])],
  }
}

// On-disk (or missing/corrupt) -> in-memory. Defaults to empty so the first-ever boot (no
// file) seeds every team from `latest` (no cold-start spam), and a corrupt file never throws.
function deserialize(raw) {
  const obj = raw && typeof raw === "object" ? raw : {}
  return {
    watermark: obj.watermark && typeof obj.watermark === "object" ? obj.watermark : {},
    seeded: new Set(Array.isArray(obj.seeded) ? obj.seeded : []),
  }
}

// Debounced persister — coalesces a burst of sweep completions into one trailing write, so a
// busy multi-workspace sweep doesn't churn the disk. `getState()` returns the live in-memory
// state (read at flush time, so the latest wins); `read`/`write` are the (atomic) IO; the
// timer is injectable for tests. `flushSync()` writes now and cancels any pending flush — the
// SIGTERM/SIGINT path calls it so a graceful shutdown never loses the last watermark.
function createSweepStatePersister({
  read,
  write,
  getState,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  debounceMs = 2000,
}) {
  let timer = null

  function scheduleFlush() {
    if (timer) return // already pending — trailing edge writes the latest state
    timer = setTimer(() => {
      timer = null
      write(serialize(getState()))
    }, debounceMs)
  }

  function flushSync() {
    if (timer) {
      clearTimer(timer)
      timer = null
    }
    write(serialize(getState()))
  }

  function load() {
    return deserialize(read())
  }

  return { load, scheduleFlush, flushSync }
}

module.exports = { serialize, deserialize, createSweepStatePersister }
