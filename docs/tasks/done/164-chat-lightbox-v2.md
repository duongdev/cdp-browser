# t164 — Lightbox v2 (zoom / pan / open-close animation)

Status: done
Scope: `/chat` only. The `/` browser build is byte-unchanged.
Plan: PSN-95 workstream A.

## What shipped

The image lightbox (`chat/src/components/image-lightbox.tsx`) gains full zoom/pan +
a smooth open/close animation.

- **Zoom/pan model** (`chat/src/lib/lightbox-zoom.ts`, pure, TDD): re-exports the
  screencast magnifier (`src/lib/canvas-zoom.ts` — `applyPinch`/`clampToViewport`/
  `IDENTITY`) and adds `zoomAround(state, pivot, nextScale, viewport)` (wheel +
  double-click, keeps the point under the cursor fixed, snaps to fit at 1×) and
  `panBy` (single-pointer drag, no-op at 1×). Same `screen = fit·scale + offset`
  math, scale ∈ [1, 4].
- **Gestures**: two-finger pinch (`applyPinch`), single-finger/mouse drag pan when
  zoomed, wheel zoom, double-click toggles fit↔2.5×. Pointer bookkeeping via a
  `pointerId` map; `touch-none select-none` so mobile browser gestures don't fight.
- **Dismiss**: Esc (kept); click-on-stage closes only when not zoomed and the
  pointer didn't pan (a drag/zoom is never a mis-close). Close button always works.
- **Animation** (`motion`, already a root dep): backdrop fades, the image card
  scales 0.92→1 on open and out on close via `AnimatePresence`.
  `prefers-reduced-motion` drops to a plain fade. Outer card owns the open/close
  scale, the inner `<img>` owns the live zoom transform, so the two never fight
  over `transform`.

## Verification

- `vitest run chat/src/lib/lightbox-zoom.test.ts` — 5 pass (zoomAround pivot-fixed /
  snap-to-fit / max-clamp, panBy no-op-at-1× / clamp).
- `tsc --noEmit` clean; biome clean (2 `!`-assertion warnings, consistent with the
  file's existing style).
- Live/HITL: pinch + animation need an on-device pass (iPad PWA) — deferred to the
  workstream-G sweep.

## Known ceilings / carry-overs

- Open animation is a centered scale+fade, not a literal projection from the tapped
  thumbnail rect (kept simple; no layout-projection dep). Revisit in G if it reads
  cheap.
- Video lightbox + a download button reuse this shell — workstream B (t165).
