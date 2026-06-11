# 079 — local pinch-zoom and pan on the screencast canvas

- **Status:** done
- **Mode:** HITL
- **Estimate:** 1d
- **Depends on:** none
- **Blocks:** none

## Goal

Two-finger pinch zooms and pans the screencast **locally** — a pure client-side transform composed into the existing Viewport Transform chain, never a remote-side mutation. The remote page keeps its desktop size; the user views it like a map, zooming where they read or tap. Input Forwarding hit-testing goes through the same composed transform, so taps land correctly at any zoom. This is the phone's answer to non-responsive sites (Slack) and supersedes ADR-0009's pinch deferral with the local variant — CDP `Input.dispatchTouchEvent` fidelity stays deferred.

## Why now

The screencast escape hatch on a phone is unusable without it (desktop-width page on a 6" screen). Independent of the shell work, and it benefits the iPad couch mode too.

## Acceptance criteria

- [ ] Two-finger pinch on the canvas zooms around the gesture midpoint; two-finger drag pans while zoomed; bounds clamped so the frame can't be lost off-screen.
- [ ] Zoomed taps/long-presses hit the correct remote element (one transform chain drives both draw and hit-testing — Viewport Transform invariant holds).
- [ ] Single-finger gestures keep today's ADR-0009 semantics (drag → scroll, tap → click, long-press → right-click) at any zoom level.
- [ ] No CDP traffic from zoom/pan: no `setDeviceMetricsOverride`, no extra screencast renegotiation.
- [ ] A reset affordance (double-tap or pinch-out past 1×) returns to fit-to-screen.
- [ ] Trackpad/mouse path byte-unchanged; iPad Safari's synthesized mouse events don't double-fire (touch pointers stay `preventDefault`ed).

## Test plan

### Layer 1 — Pure logic (TDD)

- [ ] Zoom/pan transform model — compose with letterbox math: zoom-around-point, clamping, reset; round-trip canvas↔remote coords at several zoom levels.
- [ ] Gesture classifier extension — two-finger pinch/pan vs existing single-finger gestures (`touch-gesture` model).

### Layer 2 — Manual smoke (CDP/IPC)

- [ ] On a phone-sized viewport against live desktop Slack: zoom into a message, tap a channel in the sidebar, confirm the click lands.

### Layer 3 — Visual review

- [ ] Zoomed render stays crisp-as-source (no extra blur from the local scale); pan bounds; reset behavior.

## Design notes

- **Contracts changed:** Viewport Transform gains a local zoom/pan component composed before letterbox/downscale math — one function still owns canvas→DIP for both drawing and Input Forwarding.
- **New modules:** pure zoom/pan transform model (state + compose); two-finger extension to the touch gesture classifier.
- **New ADR needed?** no — ADR-0012 §5 records it (and the ADR-0009 supersession note).
- Frame is CSS-resolution (ADR-0002 limitation) — zoom magnifies softness; accepted, this is a triage surface.

## Out of scope

- `Input.dispatchTouchEvent` / native touch fidelity, momentum scrolling (still v0.2+, ADR-0009).
- Mouse-wheel/trackpad zoom on desktop (touch-only gesture for now).
- Remote-side zoom (`Page.setPageScaleFactor` etc.) — rejected, global mutation.

## Definition of Done

- [ ] Layer 1 tests green
- [ ] Layer 2 smoke completed with a live Remote Browser
- [ ] Layer 3 screenshots captured
- [ ] `pnpm check:changed` / `pnpm typecheck` / `pnpm test` green
- [ ] CLAUDE.md (Viewport Transform bullet) updated
- [ ] No debris, no AI attribution
- [ ] Task closed: status → done, moved to `done/`, t079 in commit

## Notes

The echo cursor (t052) and hover gate interact with zoomed coords — verify the optimistic overlay maps through the same transform.

Closure notes:
- Shipped: `src/lib/canvas-zoom.ts` (9 tests — zoom-around-point invariant, clamps, snap-to-identity, pan), `toRemoteCoords` optional `zoom` arg (3 tests incl. the full letterbox+downscale+zoom round-trip), viewport.tsx wiring (multi-touch bookkeeping, ctx transform in `paintSource`, resolver inversion, ResizeObserver re-clamp, tab-switch reset to fit).
- Verified in-page against the harness by synthesizing touch PointerEvents: two-finger spread repaints zoomed, pinch-in past 1× restores a byte-identical fit render. Real-finger feel (and double-checking no Safari gesture interference) wants the iPhone/iPad HITL pass.
- Echo cursor renders at screen coords (follows the finger), so it needs no inverse mapping — only forwarded input does, and that goes through the single resolver.
- Reset affordance is pinch-out past 1× (per spec's either/or); no double-tap (it would double-click the page).
- Single-finger semantics unchanged at any zoom; mouse path byte-unchanged (identity transform short-circuits).

---

_When task status flips to `done`, move this file to `done/`._
