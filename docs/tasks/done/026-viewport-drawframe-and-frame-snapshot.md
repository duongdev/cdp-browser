# 026 — unify viewport paint geometry and frame-view snapshot

- **Status:** done
- **Mode:** HITL
- **Estimate:** 1d
- **Depends on:** none
- **Blocks:** none

## Goal

Today the canvas-sizing + Viewport Transform letterbox + fill + `drawImage` geometry is written twice in the viewport draw path — once for the decoded-`Image` path and once for the `ImageBitmap` fast path — and the draw path and Input Forwarding hit-testing each read the current Screencast Frame's size and metadata from their own independently-held refs. After this task there is a single pure `drawFrame(ctx, vp, source, frameW, frameH)` that both paint paths call, and a single **frame-view snapshot** (frame size + device size + offsetTop, captured the moment a frame is painted) that both the draw path and the Input Forwarding hit-test read from. A draw/input geometry divergence — the recurring click-offset bug class — becomes a failing pure test instead of a silent runtime mismatch.

## Why now

Canvas/letterbox geometry duplicated across two paint paths can drift the instant one path is edited and the other isn't, and there is currently nothing forcing the draw path and the hit-test to agree on which frame's dimensions they're reasoning about. Consolidating both onto one geometry helper and one snapshot kills an offset-bug class on the Screencast path that is exercised every day, and leaves the Viewport Transform seam clean for any later Input Forwarding work. No downstream task is blocked, but it removes a standing footgun in the most-used surface.

## Acceptance criteria

- [ ] A single `drawFrame` geometry helper produces canvas size, letterbox `{scale, dx, dy}`, the fill rect, and the `drawImage` placement; both the `Image` paint path and the `ImageBitmap` paint path call it (no second copy of the math).
- [ ] A single frame-view snapshot (`{ frame, device?, offsetTop }`) is captured when a frame is painted and is the only source both the draw path and the Input Forwarding hit-test read; the two independent frame refs are gone.
- [ ] `toRemoteCoords` and `drawFrame` are proven to agree on a synthetic snapshot: a point drawn at canvas position P maps back through `toRemoteCoords` to the remote DIP that `drawFrame` would have placed under P (round-trip within rounding).
- [ ] `viewport-transform.ts` stays pure and DOM-free — `drawFrame` geometry lives here as a pure function returning a layout; the actual `ctx` fill + `drawImage` (the only DOM/Canvas touch) stays in the renderer component.
- [ ] On a downscaled + letterboxed Screencast Frame, clicks land on the correct remote element with Adaptive Viewport both off and on.
- [ ] No regression to letterbox bars, fill color, or frame placement; screencast paints crisply with no jiggle on sidebar toggle or container resize.

## Test plan

### Layer 1 — Pure logic (TDD)

- [ ] `viewport-transform.ts` `drawFrame` (pure geometry layout) — covers a frame matching canvas aspect (no bars), a wider-than-canvas frame (top/bottom bars), and a taller-than-canvas frame (left/right bars); asserts `scale`, `dx`, `dy`, fill rect, and `drawImage` dest rect.
- [ ] `viewport-transform.ts` `drawFrame` — covers a downscaled frame (frame smaller than device) and asserts the dest placement still fills the same canvas region (image px, not DIP, drive `drawImage`).
- [ ] `viewport-transform.ts` draw/input agreement — for a synthetic frame-view snapshot, assert the center and each corner of the drawn frame rect round-trip through `toRemoteCoords` to the expected Remote Page DIP (the divergence-proof test).
- [ ] `viewport-transform.ts` `toRemoteCoords` — existing letterbox + downscale + `offsetTop` cases stay green after the snapshot refactor (no contract change to the mapping itself).

### Layer 2 — Manual smoke (CDP/IPC)

Steps to manually verify with a live Remote Browser:

- [ ] Connect to a tab whose remote layout viewport is larger than the local canvas (forces a downscaled frame). Click a link near each corner and dead-center; each click lands on the element under the cursor (no compression toward top-left).
- [ ] Repeat with the window aspect ratio mismatched so letterbox bars appear (e.g. a narrow window): clicks inside the framed area land correctly and clicks on the black bars do nothing odd.
- [ ] Toggle Adaptive Viewport on and repeat the corner + center clicks: hit-testing stays accurate with bars eliminated.
- [ ] Drag-select text and drag-scroll: drag coordinates track the cursor continuously (no offset that grows toward an edge).

### Layer 3 — Visual review

- [ ] Screenshots captured via Chrome MCP against `pnpm dev`.
- [ ] All four states visible: loading (connecting, no frame yet), empty (no tab / blank page), error (endpoint unreachable status), populated (live screencast painting).
- [ ] Toggle the sidebar collapsed/expanded and drag-resize the sidebar width while a frame is painting: the canvas repaints crisply with no jiggle, no stale-frame smear, and the framed image re-centers smoothly.

## Design notes

The change is internal to the Viewport Transform seam and its single renderer consumer. `viewport-transform.ts` remains pure and DOM-free: the new `drawFrame` returns a geometry layout (the same `Letterbox` plus the source/dest rectangles), and the renderer applies that layout to the 2D context. Both the decoded-`Image` path and the `ImageBitmap` fast path call the one helper and then issue the identical `ctx.fillRect` + `ctx.drawImage` sequence over its result. The two separately-held frame refs collapse into one **frame-view snapshot** value captured at paint time; the Input Forwarding hit-test reads that same snapshot when calling `toRemoteCoords`, so draw and input can never reason about different frame dimensions.

- **Contracts changed:** `viewport-transform.ts` public surface — gains a pure `drawFrame(ctx, vp, source, frameW, frameH)`-shaped geometry function returning the canvas size, `Letterbox`, fill rect, and `drawImage` dest rect; `letterbox` and `toRemoteCoords` are unchanged. The renderer's two private frame refs are replaced by one `FrameView` snapshot value read by both the draw path and the hit-test (renderer-internal, not a `src/lib` export contract change).
- **New modules:** none — `drawFrame` lives alongside `letterbox`/`toRemoteCoords` in the existing Viewport Transform module; co-locating the geometry keeps the single-source-of-truth invariant and the locality the module already documents.
- **New ADR needed?** no — this implements the documented "the same transform must drive both drawing and Input Forwarding hit-testing" invariant from CONTEXT.md; no new decision.

```ts
// pure: one geometry source, no ctx mutation inside the lib
interface FrameLayout {
  canvas: Size              // device-pixel canvas size
  box: Letterbox            // { scale, dx, dy }
  fill: Rect                // black-bar fill region (whole canvas)
  dest: { x: number; y: number; w: number; h: number } // drawImage placement
}
function drawFrame(canvasSize: Size, frame: Size): FrameLayout

// the single snapshot both paths read; captured when a frame is painted
interface FrameView {
  frame: Size               // image px of the painted Screencast Frame
  device?: Size             // metadata deviceWidth/deviceHeight when downscaled
  offsetTop: number         // metadata vertical DIP offset (0 on desktop)
}
// draw path: drawFrame(canvasSize, view.frame) -> ctx.fillRect + ctx.drawImage
// input path: toRemoteCoords(client, rect, dpr, view.frame, view.device, view.offsetTop)
```

## Out of scope

- Any change to the `toRemoteCoords` mapping math, the `device`/`offsetTop` semantics, or the `Letterbox` formula.
- Adaptive Viewport state-machine behavior (`adaptive-viewport.ts`) — only verified, not modified.
- New Input Forwarding kinds (IME, paste, drag-as-file) — the `InputIntent` seam is untouched.
- Screencast frame sharpness / device-resolution capture (the documented CSS-resolution limitation) — unchanged.
- The web build's frame transport, ack path, or `cdp-web-transport.ts` routing — geometry is shared by both backends already through this module; no transport edits here.

## Definition of Done

All must be true before status → done.

- [ ] Layer 1 tests written and green (if pure logic was touched)
- [ ] Layer 2 smoke checklist completed with a live Remote Browser (if main.js/IPC touched)
- [ ] Layer 3 screenshots captured and committed (if UI touched)
- [ ] `pnpm check` clean (Biome — lint + format)
- [ ] `pnpm typecheck` clean
- [ ] `pnpm test` green
- [ ] `pnpm dev` boots cleanly and the changed surface works end-to-end
- [ ] CLAUDE.md updated for any modified module
- [ ] ADR written if an architectural decision was made
- [ ] No commented-out code, no `console.log` debris, no AI attribution
- [ ] Task closed: status → done, file moved to `docs/tasks/done/`, tNNN in commit

## Notes

The divergence-proof test (draw and input agree on one snapshot) is the heart of this task — write it first and let it fail before consolidating the refs. The `ImageBitmap` fast path and the decoded-`Image` path differ only in the `source` argument to `drawImage`; everything before it (sizing, letterbox, fill) is identical and is exactly what `drawFrame` absorbs. Keep the lib pure: the only thing that touches the 2D context stays in the renderer component, fed by the `FrameLayout` the pure helper returns.

---

_When task status flips to `done`, move this file to `done/`._
