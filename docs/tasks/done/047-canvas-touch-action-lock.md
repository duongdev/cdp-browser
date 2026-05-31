# 047 — lock touch-action + user-scalable so finger gestures don't pan the shell

- **Status:** done
- **Mode:** HITL
- **Ring:** inner
- **Slice:** 2-ipad-shell
- **Estimate:** 0.5d
- **Depends on:** 033 (touch-first input convention + ADR-0009)
- **Blocks:** 051 (touch-scroll-tap forwarding)

## Goal

On the iPad PWA today, a finger dragged across the screencast canvas scrolls and pinch-zooms the *PWA shell* instead of reaching the remote page — the browser eats the gesture before the app sees it. After this task, the viewport meta declares the shell non-zoomable (`user-scalable=no`, `maximum-scale=1`) and the screencast canvas (plus any surface that must own finger gestures) carries `touch-action: none`, so a single finger on the canvas is captured by the app, not the browser. The remote page no longer drifts under the user's finger, and pinch never zooms the shell. This is the prerequisite that makes touch input forwarding possible.

## Why now

This is a v0.1.0 inner-ring gate item: the web PWA is the release surface and the iPad is the daily driver. Touch-scroll-tap forwarding (t051 — finger drag → `mouseWheel`, tap → click, long-press → right-click, reusing the existing mouse pipeline + `toRemoteCoords`) cannot work until the browser stops intercepting finger gestures over the canvas. Locking `touch-action` here is the cheap, structural unblock for the whole input-feel slice. It is convention-gated by t033 (touch as a co-primary input model), so the lock lands only after the convention that justifies it.

## Acceptance criteria

- [ ] `index.html` viewport meta includes `user-scalable=no, maximum-scale=1` alongside the existing `width=device-width, initial-scale=1.0, viewport-fit=cover`
- [ ] The screencast canvas carries `touch-action: none` so single-finger drag over it does not scroll or pan the shell
- [ ] Pinch on the canvas does not zoom the PWA (double-tap-zoom and pinch-zoom of the shell are both suppressed)
- [ ] Any other surface that must own finger gestures (e.g. the viewport container) is covered so the gesture is not stolen mid-drag
- [ ] The lock does not break scrolling where it should still work — the sidebar list and settings drawer still scroll with a finger (only gesture-owning surfaces get `touch-action: none`)
- [ ] Existing mouse/trackpad behaviour on desktop web and Electron is unchanged
- [ ] No change to the existing safe-area / `100dvh` body layout from t015

## Test plan

### Layer 1 — Pure logic (TDD)

n/a — this task only touches the viewport meta and CSS (`touch-action`); no pure logic.

### Layer 2 — Manual smoke (CDP/IPC)

n/a — no main-process or IPC code is touched. (`web/server.mjs` and `main.js` are untouched.)

### Layer 3 — Visual review

- [ ] Desktop web (`pnpm web`, Chrome DevTools device emulation as iPad): confirm the canvas computes `touch-action: none` and the viewport meta carries `user-scalable=no, maximum-scale=1`; mouse drag/click/wheel still work
- [ ] Sidebar list and settings drawer still scroll under a simulated finger
- [ ] **HITL — iPad physical:** single-finger drag on the canvas does NOT scroll/zoom the shell; pinch does not zoom the PWA; the remote page stays put under the finger
- [ ] **HITL — iPad physical:** screenshot or screen recording of a finger drag over the canvas showing the shell does not move, captured and attached to the task

## Design notes

Describe the behavioral change, not a line-by-line patch.

- **`index.html` viewport meta:** extend the existing `content` string with `user-scalable=no, maximum-scale=1`. This is the standalone-PWA contract for "the app owns zoom, the browser does not." `viewport-fit=cover` (from t015) stays.
- **`src/components/viewport.tsx` canvas:** the screencast `<canvas>` (and, if the gesture is observed on the wrapping container rather than the canvas itself, the `containerRef` div) gets `touch-action: none`. The canvas already calls `e.preventDefault()` on mouse/wheel/context-menu to keep gestures from the native layer; `touch-action: none` is the touch-pointer equivalent and must be set declaratively (it cannot be undone by a passive listener's `preventDefault`). Apply via a Tailwind utility class (`touch-none`) to match the component's existing class-driven style.
- **`src/index.css`:** if a global rule is the cleaner home (e.g. the gesture surface is broader than the canvas), add a scoped `touch-action: none` there rather than on `body` — locking `body` would kill legitimate scroll in the sidebar/settings drawer. Default to the component-scoped class; reach for `index.css` only for a surface that has no component to hang the class on. Leave the existing `body { overflow: hidden; height: 100dvh }` block alone.
- **Contracts changed:** none — meta + CSS only. No TypeScript interface changes.
- **New modules:** none.
- **New ADR needed?** no — the architectural decision (touch as co-primary input) is recorded by t033's ADR-0009; this task is the mechanical CSS/meta consequence of that decision.

## Out of scope

- Touch event *forwarding* (finger drag → `mouseWheel`, tap → click, long-press → right-click) — that is t051, which this task unblocks.
- Local echo cursor / optimistic press (t052).
- Full `Input.dispatchTouchEvent` (pinch/momentum on the remote page) — deferred to v0.2.
- On-screen-keyboard bridge — deferred to v0.2.
- Any change to the sidebar/settings scroll behaviour beyond *not* breaking it.

## Definition of Done

All must be true before status → done.

- [ ] Layer 1 tests written and green (if pure logic was touched) — n/a here
- [ ] Layer 2 smoke checklist completed with a live Remote Browser (if main.js/IPC touched) — n/a here
- [ ] Layer 3 screenshots captured and committed (if UI touched)
- [ ] `pnpm check` clean (Biome — lint + format) on the files touched
- [ ] `pnpm typecheck` clean
- [ ] `pnpm test` green
- [ ] `pnpm dev` / `pnpm web` boots cleanly and the changed surface works end-to-end
- [ ] CLAUDE.md updated for any modified module (none expected — meta/CSS only)
- [ ] ADR written if an architectural decision was made (none — covered by t033/ADR-0009)
- [ ] No commented-out code, no `console.log` debris, no AI attribution
- [ ] Task closed: status → done, file moved to `docs/tasks/done/`, t047 in commit

## Notes

- `touch-action: none` is the right tool over `e.preventDefault()` in a touch handler: iOS Safari registers `touchstart`/`touchmove` listeners as passive by default, so `preventDefault()` inside them is ignored — only the declarative CSS property reliably stops the shell from panning/zooming.
- `user-scalable=no` is intentionally honoured on a standalone PWA (the iOS accessibility override that ignores it in a normal Safari tab does not apply once Added to Home Screen); the daily-driver target is the installed PWA.
- Keep the lock surgical: only gesture-owning surfaces get `touch-action: none`. Locking `body` would regress legitimate finger-scroll in the sidebar list and the settings drawer — verify both still scroll.
- Verify on the t018 hardware pass that this lock did not introduce a "stuck" feel anywhere a finger-scroll is expected.

---

_When task status flips to `done`, move this file to `done/`._
