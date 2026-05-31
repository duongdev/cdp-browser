// Quality-latency tier: the single owner of the Sharp / Balanced / Snappy screencast
// presets (t055). Each tier maps to a fixed `{ jpegQuality, everyNthFrame }` pair fed
// straight into Page.startScreencast — sharper = higher JPEG quality + every frame;
// snappier = lower quality + skip frames (cheaper to composite, lower latency on a slow
// link). Latency matters more than sharpness, so the default is Balanced, which equals
// today's behavior (quality 80, everyNthFrame 2 — see t054) so existing users see no
// change until they opt in.
//
// Root CJS so both backends read the same numbers (ADR-0008): remote-page-connector.js
// and main.js's inline startScreencast require this; neither hardcodes a literal. The
// renderer (settings-dialog.tsx, web-only picker) imports the tier list + storage key by
// relative path. Pure — no I/O. Tested by quality-tier.test.ts.

// Sharp → Balanced → Snappy, ordered by descending jpegQuality + ascending everyNthFrame.
const TIERS = [
  { id: "sharp", label: "Sharp", params: { jpegQuality: 92, everyNthFrame: 1 } },
  { id: "balanced", label: "Balanced", params: { jpegQuality: 80, everyNthFrame: 2 } },
  { id: "snappy", label: "Snappy", params: { jpegQuality: 60, everyNthFrame: 3 } },
]

const DEFAULT_TIER = "balanced"

const BY_ID = new Map(TIERS.map((t) => [t.id, t]))

// tierToParams(tier) → { jpegQuality, everyNthFrame }. An unknown tier falls back to the
// default so a corrupt stored value never produces a bad startScreencast.
function tierToParams(tier) {
  return (BY_ID.get(tier) || BY_ID.get(DEFAULT_TIER)).params
}

// parseTier(raw) → a known tier id. Garbage / null / wrong case → DEFAULT_TIER.
function parseTier(raw) {
  return typeof raw === "string" && BY_ID.has(raw) ? raw : DEFAULT_TIER
}

module.exports = { TIERS, DEFAULT_TIER, tierToParams, parseTier }
