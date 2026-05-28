/**
 * Tiny tagged perf accumulator for /diagnose t019-perf. Records stage durations per
 * frame; flushes p50/p95 to console every 1s. Disabled unless `?perf=1` in the URL,
 * so it costs ~0 in production. Remove together with the [DEBUG-perf] markers when
 * the bottleneck is identified.
 */
type Stage =
  | "wsRecv" // WS onmessage → parsed envelope
  | "jsonParse" // just the JSON.parse call
  | "frameToDecode" // onFrame callback entry → img.onload
  | "paint" // drawImage call

// Enable via `?perf=1` (web) OR `localStorage.perf = '1'` (works in Electron too,
// where there's no query string). Run `localStorage.perf='1'` in DevTools console then
// reload to start measuring. `localStorage.removeItem('perf')` + reload to stop.
const enabled =
  (typeof location !== "undefined" && new URLSearchParams(location.search).get("perf") === "1") ||
  (typeof localStorage !== "undefined" && localStorage.getItem("perf") === "1")

const buckets = new Map<Stage, number[]>()
let frames = 0
let lastFlush = enabled ? performance.now() : 0

export function perfMark(stage: Stage, ms: number) {
  if (!enabled) return
  let arr = buckets.get(stage)
  if (!arr) {
    arr = []
    buckets.set(stage, arr)
  }
  arr.push(ms)
}

export function perfFrame() {
  if (!enabled) return
  frames++
  const now = performance.now()
  if (now - lastFlush < 1000) return
  const fps = (frames * 1000) / (now - lastFlush)
  const out: Record<string, string> = { fps: fps.toFixed(1) }
  for (const [stage, arr] of buckets) {
    arr.sort((a, b) => a - b)
    const p50 = arr[Math.floor(arr.length * 0.5)] ?? 0
    const p95 = arr[Math.floor(arr.length * 0.95)] ?? 0
    out[stage] = `${p50.toFixed(1)}/${p95.toFixed(1)}ms` // p50/p95
  }
  // biome-ignore lint/suspicious/noConsole: diagnostic logging
  console.log("[DEBUG-perf]", JSON.stringify(out))
  buckets.clear()
  frames = 0
  lastFlush = now
}
