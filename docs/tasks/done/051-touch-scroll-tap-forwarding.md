# 051 — touch-scroll-tap: finger drag → mouseWheel, tap → click, long-press → right-click

- **Status:** done
- **Mode:** HITL
- **Ring:** inner
- **Slice:** 3-input-feel
- **Estimate:** 1d
- **Depends on:** 033 (touch-first-input-convention-and-adr), 047 (canvas-touch-action-lock)
- **Blocks:** none

## Goal

On an iPad with no keyboard or trackpad, the screencast is dead to the finger — there is no touch input at all, so couch use is impossible. After this task a single finger on the canvas drives the remote page: a **drag scrolls** (finger movement → `mouseWheel` deltas), a **tap clicks** (`mousePressed`/`mouseReleased` at the tapped point), and a **long-press opens the context menu** (a right-click). All three route through the existing Input Forwarding pipeline and `toRemoteCoords`, so finger input lands exactly where the user touches, just like the mouse path. Magic Keyboard + trackpad stays the primary input model; this is the finger-only secondary path for couch reading.

## Why now

The v0.1.0 gate is the iPad PWA as a daily driver, and t018's hard acceptance gate now includes a couch finger-scroll/tap verification line. A browser you can't scroll or tap with one finger fails that gate on the spot. This is the minimum finger interaction that makes the screencast usable away from the keyboard — the cheap, pipeline-reusing slice. Richer touch (pinch-zoom, momentum, on-screen keyboard) is explicitly out and deferred to v0.2; this unblocks the gate without that scope.

## Acceptance criteria

- [ ] Single-finger **drag** on the canvas scrolls the remote page: finger movement is accumulated into `mouseWheel` deltas through the existing wheel path (`toRemoteCoords` resolves the anchor point). Drag direction matches natural content scrolling (drag down → content moves down).
- [ ] A **tap** (touch down + up under the movement threshold and within the time window) fires one `mousePressed` + `mouseReleased` at the tapped coordinates — a click lands where the finger touched, with no spurious scroll.
- [ ] A **long-press** (held past the time threshold with no movement) fires a **right-click** (`button: "right"` press + release) at the touched point, opening the remote context menu.
- [ ] The gesture classifier (drag vs tap vs long-press; movement threshold + timing; drag-delta accumulation) is a **pure, unit-tested module** (`src/lib/touch-gesture.ts`) with no DOM or React dependency.
- [ ] No new `InputIntent` variant and no new Remote Page seam: touch maps onto the existing `wheel` / `mouse` intents. `remote-page.ts` changes are limited to what (if anything) the mapping needs (see Design notes), not a new verb.
- [ ] Touch input only fires from real touch (`PointerEvent` with `pointerType === "touch"`); mouse/trackpad pointers keep going through the existing mouse handlers untouched — no double-dispatch, no regressions on the fine-pointer path.
- [ ] `pnpm check` (touched files) / `pnpm typecheck` / `pnpm test` green.

## Test plan

### Layer 1 — Pure logic (TDD)

`src/lib/touch-gesture.ts` — a pure classifier fed a sequence of touch samples (`{ x, y, t }`) and emitting gesture outcomes. Strict TDD:

- [ ] `touch-gesture` — down then up under the movement threshold and within the tap time window classifies as **tap** at the down/up coordinates.
- [ ] `touch-gesture` — down, holds past the long-press time threshold with movement under the threshold classifies as **long-press** (right-click) at the down coordinates.
- [ ] `touch-gesture` — down then moves past the movement threshold classifies as **drag**; subsequent moves emit accumulated `mouseWheel` deltas (Δx/Δy between successive samples, sign matching natural scroll).
- [ ] `touch-gesture` — a drag that has begun never later re-classifies as a tap or long-press, even if the finger pauses (once a drag, always a drag for that gesture).
- [ ] `touch-gesture` — movement just under the threshold during the hold still allows long-press (jitter tolerance); movement just over cancels long-press into a drag.
- [ ] `touch-gesture` — boundary cases: exactly-at-threshold movement and exactly-at-window timing resolve deterministically (document which side the boundary falls on).

### Layer 2 — Manual smoke (CDP/IPC)

HITL — needs a live Remote Browser and a touch device (iPad PWA, or Chrome DevTools touch emulation for a first pass):

- [ ] Finger **drag** up/down on a long page scrolls it smoothly; no click is registered mid-scroll.
- [ ] Single **tap** on a known link/button activates that exact element (coordinates correct, no offset — confirms the gesture coords flow through `toRemoteCoords` like the mouse path, including on a downscaled frame per t014).
- [ ] **Long-press** on a page region opens the remote browser's context menu at the touched point.
- [ ] Mouse/trackpad input (when a Magic Keyboard/trackpad is attached) still behaves exactly as before — no double events, no scroll-on-click.

### Layer 3 — Visual review

- [ ] Desktop-web capture via Chrome DevTools touch emulation against `pnpm web`: a recording (or before/after frames) of finger scroll, tap, and long-press behaving correctly.
- [ ] HITL: confirmed on a physical iPad against the live web build (finger scroll/tap/long-press) — this is the real surface and rolls up into the t018 couch verification line.

## Design notes

The whole change reuses the existing Input Forwarding pipeline — no new transport verb, no Remote Page intention, no main-process work. PointerEvents on the canvas, when `pointerType === "touch"`, are fed to the pure classifier, which emits the same `InputIntent`s the mouse/wheel handlers already produce.

- **New modules:** `src/lib/touch-gesture.ts` — a pure gesture classifier. Input is a stream of touch samples; output is a sequence of gesture events (`{ type: "scroll"; deltaX; deltaY; x; y }` | `{ type: "tap"; x; y }` | `{ type: "longpress"; x; y }`). Holds per-gesture state (down point, down time, accumulated movement, whether it has committed to a drag) created fresh per touch via a small factory; no React, no DOM, no timers in the module itself (the long-press deadline is a caller-supplied `now`/elapsed check so it stays pure and testable). Justification: classification is the only non-trivial logic and must be TDD'd in isolation per the project's Layer-1 rule.

- **Contracts changed:** `src/components/viewport.tsx` — the canvas grows `onPointerDown`/`onPointerMove`/`onPointerUp`/`onPointerCancel` handlers that ignore non-touch pointers (those stay on the existing `onMouseDown`/`onMouseMove`/`onMouseUp`/`onWheel` path) and, for touch, drive a per-gesture classifier instance. Each emitted gesture event is translated into an existing `InputIntent` and handed to `page.forwardInput`:
  - `scroll` → `{ kind: "wheel", event: { clientX, clientY, deltaX, deltaY, …modifiers:false } }` (reuses the `mouseWheel` path and `toRemoteCoords` anchor).
  - `tap` → `{ kind: "mouse", phase: "pressed", event: { …, button: 0, buttons: 1 }, clickCount: 1 }` immediately followed by `{ kind: "mouse", phase: "released", event: { …, button: 0, buttons: 0 }, clickCount: 1 }`.
  - `longpress` → the same pressed/released pair but with `button: 2`, `buttons: 2` so `forwardInput` maps it to CDP `button: "right"` (the existing `CDP_BUTTON` table already handles right).
  Touch must also `e.preventDefault()` / consume so the gesture never bubbles into shell panning — but the actual `touch-action`/`user-scalable` lock that stops the *page chrome* from panning is t047's job (a dependency), not duplicated here.

- **`remote-page.ts`:** expected to need **no** change — the mapped `wheel`/`mouse` intents already exist and `forwardInput` already resolves coords and dispatches them. It's in `filesToTouch` only as a fallback in case the synthetic mouse-event-like payload needs a field the current `MouseEventLike`/`WheelEventLike` shapes don't carry (e.g. a touch source has no real `button`/`buttons`/`detail`). If a change is needed it stays a payload-shape accommodation, **not** a new `InputIntent` variant. Prefer constructing a minimal event-like object in `viewport.tsx` over touching the seam.

- **New ADR needed?** No. The touch-as-co-primary-input *decision* is recorded by t033's ADR-0009 (a dependency); this task is the implementation of the lightweight slice that decision scoped. No new architectural choice here.

```ts
// pure classifier — fresh instance per touch gesture
interface TouchSample { x: number; y: number; t: number }
type GestureEvent =
  | { type: "scroll"; deltaX: number; deltaY: number; x: number; y: number }
  | { type: "tap"; x: number; y: number }
  | { type: "longpress"; x: number; y: number }

interface TouchGesture {
  down(s: TouchSample): GestureEvent[]   // usually [] until classified
  move(s: TouchSample): GestureEvent[]   // drag → scroll deltas; pre-commit may stay []
  up(s: TouchSample): GestureEvent[]     // tap if not yet a drag/long-press
  poll(now: number): GestureEvent[]      // long-press deadline check (pure, caller-driven)
}
```

Coordinate fidelity comes for free: every emitted gesture carries client coords that flow through `forwardInput` → `resolveCoords` → `toRemoteCoords`, the same path the mouse uses, so the downscaled-frame mapping fixed in t014 applies unchanged.

## Out of scope

- **Full `Input.dispatchTouchEvent`** (native touch dispatch, pinch-to-zoom, multi-finger gestures, fling/momentum scrolling) — deferred to v0.2. This task synthesizes mouse/wheel only.
- **On-screen keyboard bridge** (XL) — deferred to v0.2; finger text entry is not addressed here.
- **Two-finger / trackpad-style gestures** and momentum/inertia after release — not in this slice.
- **The shell `touch-action` / `user-scalable` lock** that stops finger gestures from panning the PWA chrome — that's t047 (a dependency), not re-done here.
- **Local echo cursor / optimistic press** for instant feedback — that's t052, the sibling task in this slice.

## Definition of Done

All must be true before status → done.

- [ ] Layer 1 tests written and green (`src/lib/touch-gesture.ts`).
- [ ] Layer 2 smoke checklist completed with a live Remote Browser (HITL).
- [ ] Layer 3 capture taken (Chrome touch emulation) and physical-iPad behavior confirmed (HITL).
- [ ] `pnpm check` clean (Biome — lint + format, touched files).
- [ ] `pnpm typecheck` clean.
- [ ] `pnpm test` green.
- [ ] `pnpm web` boots cleanly and finger scroll/tap/long-press work end-to-end on the web build.
- [ ] `src/lib/CLAUDE.md` updated with the new `touch-gesture.ts` module entry; CLAUDE.md "Input Forwarding"/known-limitations touched if the touch path changes documented behavior.
- [ ] ADR: none new (the decision lives in t033's ADR-0009).
- [ ] No commented-out code, no `console.log` debris, no AI attribution.
- [ ] Task closed: status → done, file moved to `docs/tasks/done/`, `t051` in branch + commit.

## Notes

- Keep the classifier instance fresh per gesture (one per `pointerdown` for a touch pointer) so no state leaks between touches. A `pointercancel` (e.g. the OS steals the gesture) must discard the in-flight instance without emitting a tap.
- The long-press deadline being a caller-driven `poll(now)` keeps the module timer-free and pure; the component owns the `setTimeout`/`rAF` that calls `poll`. Mirror the pattern used elsewhere (effects executed by the caller, logic stays pure).
- Natural-scroll sign: dragging the finger **down** should move the page content down (reveal content above), i.e. a negative `deltaY` to the wheel path — confirm the sign against the live page during smoke and lock it in a Layer-1 case so it can't silently flip.
- Tap should not require pixel-perfect stillness — allow a small movement threshold (finger jitter) before a touch is reclassified as a drag, matching native tap tolerance.
