// Pure zoom helper for the lightbox (t164). Reuses the screencast magnifier model
// (`src/lib/canvas-zoom.ts`): `screen = fit · scale + offset` in container-relative CSS px,
// scale ∈ [1, MAX_SCALE]. Touch pinch/pan folds through `applyPinch`; wheel + double-click
// zoom around a pivot fold through `zoomAround` (same pin math as applyPinch's translate part,
// factored out so a discrete zoom keeps the point under the cursor fixed).

import {
  applyPinch,
  clampToViewport,
  IDENTITY,
  isZoomed,
  MAX_SCALE,
  type Point,
  type ViewSize,
  type ZoomState,
} from "@/lib/canvas-zoom"

export type { Point, ViewSize, ZoomState }
export { applyPinch, clampToViewport, IDENTITY, isZoomed, MAX_SCALE }

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** Zoom to `nextScale` keeping `pivot` (container-relative CSS px) fixed on screen.
 *  Reaching 1× snaps to IDENTITY (fit). Drives wheel + double-click zoom. */
export function zoomAround(
  state: ZoomState,
  pivot: Point,
  nextScale: number,
  viewport: ViewSize,
): ZoomState {
  const scale = clamp(nextScale, 1, MAX_SCALE)
  if (scale === 1) return IDENTITY
  const k = scale / state.scale
  const x = pivot.x - (pivot.x - state.x) * k
  const y = pivot.y - (pivot.y - state.y) * k
  return clampToViewport({ scale, x, y }, viewport)
}

/** Pan the zoomed content by a screen-space delta (single-finger / mouse drag). No-op at 1×. */
export function panBy(state: ZoomState, dx: number, dy: number, viewport: ViewSize): ZoomState {
  if (!isZoomed(state)) return state
  return clampToViewport({ ...state, x: state.x + dx, y: state.y + dy }, viewport)
}
