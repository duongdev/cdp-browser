// Local pinch-zoom/pan for the screencast canvas (t079, ADR-0012 §5). Pure model of a
// client-side magnifier transform composed ON TOP of the existing letterbox fit: the
// remote page is never resized (no device-metrics override, no CDP traffic) — the user
// zooms into the already-rendered frame like a map. `screen = fit · scale + offset`,
// all in container-relative CSS px. The draw path applies it as a 2D-context transform;
// Input Forwarding inverts it (`toFitPoint`) before the normal `toRemoteCoords` math.

export interface ZoomState {
  scale: number
  /** Offset of the fit-space origin on screen, CSS px. Always ≤ 0 when zoomed. */
  x: number
  y: number
}

export interface Point {
  x: number
  y: number
}

export interface ViewSize {
  w: number
  h: number
}

export const IDENTITY: ZoomState = { scale: 1, x: 0, y: 0 }
export const MAX_SCALE = 4

export function isZoomed(state: ZoomState): boolean {
  return state.scale !== 1
}

/** Inverse transform: a screen point back into fit (un-zoomed letterbox) space. */
export function toFitPoint(state: ZoomState, p: Point): Point {
  return { x: (p.x - state.x) / state.scale, y: (p.y - state.y) / state.scale }
}

/** Pin the offsets so zoomed content always covers the viewport (no over-pan voids). */
export function clampToViewport(state: ZoomState, viewport: ViewSize): ZoomState {
  const minX = viewport.w * (1 - state.scale)
  const minY = viewport.h * (1 - state.scale)
  const x = Math.min(0, Math.max(minX, state.x))
  const y = Math.min(0, Math.max(minY, state.y))
  return x === state.x && y === state.y ? state : { ...state, x, y }
}

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y) || 1
const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })

/**
 * Fold one two-finger update (previous pair → current pair, container-relative CSS px)
 * into the zoom state. One formula carries both gestures: the distance ratio scales
 * around the midpoint, the midpoint translation pans. Scale clamps to [1, MAX_SCALE];
 * reaching 1 snaps to IDENTITY (pinching out past 1× is the reset affordance).
 */
export function applyPinch(
  state: ZoomState,
  prev: [Point, Point],
  cur: [Point, Point],
  viewport: ViewSize,
): ZoomState {
  const factor = dist(cur[0], cur[1]) / dist(prev[0], prev[1])
  const scale = Math.min(MAX_SCALE, Math.max(1, state.scale * factor))
  if (scale === 1) return IDENTITY
  const m0 = mid(prev[0], prev[1])
  const m1 = mid(cur[0], cur[1])
  // Keep the content point under the old midpoint pinned under the new midpoint.
  const k = scale / state.scale
  const x = m1.x - (m0.x - state.x) * k
  const y = m1.y - (m0.y - state.y) * k
  return clampToViewport({ scale, x, y }, viewport)
}
