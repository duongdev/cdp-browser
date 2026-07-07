// Renderer-facing half of the quality-latency tier (t055). The screencast params
// (jpegQuality + everyNthFrame) live in the root CJS `quality-tier.js`, the single owner
// read by both backends (remote-page-connector.js + main.js) per ADR-0008 — the renderer
// never applies them, the server does. This module owns only what the web-only Settings
// picker needs: the tier id type, the option list shown in the 2x2-style toggle, a
// parse-with-fallback, and a live in-memory mirror of the active tier for the resize reissue.
// Mirrors how transport-selector.ts owns the InputTransportMode ids for the t019 picker.

export type QualityTier = "sharp" | "balanced" | "snappy"

export const DEFAULT_TIER: QualityTier = "balanced"

// Sharp → Balanced → Snappy, the same order and ids the root mapping uses. Labels/tips are
// presentation-only; the load-bearing numbers stay in quality-tier.js.
export const QUALITY_TIERS: { id: QualityTier; label: string; tip: string }[] = [
  { id: "sharp", label: "Sharp", tip: "Highest JPEG quality, every frame. Best on a fast link." },
  { id: "balanced", label: "Balanced", tip: "Default — today's quality and frame rate." },
  {
    id: "snappy",
    label: "Snappy",
    tip: "Lower quality, fewer frames. Lowest latency on a slow link.",
  },
]

// Screencast params per tier — MIRRORS `core/quality-tier.js` `tierToParams` (kept in sync by
// quality-tier.test.ts). The server owns params on the connect path (ADR-0008); this mirror
// exists ONLY for the renderer-initiated resize reissue in viewport.tsx, which must preserve
// the user's tier (jpegQuality + everyNthFrame / the t054 rate ceiling) instead of resetting to
// a hardcoded default on every resize (t099). Do not read this anywhere the server applies params.
const TIER_PARAMS: Record<QualityTier, { jpegQuality: number; everyNthFrame: number }> = {
  sharp: { jpegQuality: 92, everyNthFrame: 1 },
  balanced: { jpegQuality: 80, everyNthFrame: 2 },
  snappy: { jpegQuality: 60, everyNthFrame: 3 },
}

// The startScreencast quality params for a tier id (unknown → default), for the resize reissue.
export function tierParams(tier: string | null | undefined): {
  jpegQuality: number
  everyNthFrame: number
} {
  return TIER_PARAMS[parseTier(tier)]
}

const VALID = new Set<QualityTier>(QUALITY_TIERS.map((t) => t.id))

// Garbage / null / wrong case → DEFAULT_TIER, matching the root parseTier so a corrupt
// stored value resolves the same way on both sides.
export function parseTier(raw: string | null | undefined): QualityTier {
  return typeof raw === "string" && VALID.has(raw as QualityTier)
    ? (raw as QualityTier)
    : DEFAULT_TIER
}

// Live in-memory mirror of this device's active tier (t100). The screencast resize reissue in
// viewport.tsx needs the tier synchronously, but the durable value lives in server ui-state now
// (not localStorage, which resets on the iPad PWA) — so app.tsx seeds this at boot from ui-state
// and the Settings picker updates it on change. Same live-mirror shape as latency-hud.tsx's flag;
// without it, a resize would read a now-empty localStorage and reset the tier to balanced (the
// exact t099 regression). Not the source of truth — server ui-state is; this is a sync read cache.
let currentTier: QualityTier = DEFAULT_TIER

export function readCurrentTier(): QualityTier {
  return currentTier
}

export function setCurrentTier(raw: string | null | undefined): void {
  currentTier = parseTier(raw)
}
