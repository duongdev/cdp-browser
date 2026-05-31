# 052 — local echo cursor + optimistic press for instant input feedback

- **Status:** done
- **Mode:** HITL
- **Ring:** inner
- **Slice:** 3-input-feel
- **Estimate:** 1d
- **Depends on:** none
- **Blocks:** none

## Goal

On a slow link, pointing and clicking feels laggy because nothing on screen
moves until the next remote Screencast Frame returns — the cursor, the button
press, the click ripple all wait a full round-trip. After this task the viewport
draws a **local echo cursor** that tracks the pointer (or touch point) instantly,
plus an **optimistic press affordance** that flashes the moment a press is
forwarded — both rendered client-side from the same coordinates we already send
to the Remote Page, so the gesture reads as immediate regardless of RTT. The
remote frame still confirms reality a beat later; the echo just removes the dead
air before it.

## Why now

The v0.1.0 gate is "would I daily-drive this on the iPad PWA," and the synthesis
called a local echo cursor the single biggest *felt*-latency win — it's
independent of RTT, so it pays off worst exactly where the link is worst (couch
Wi-Fi, portal/Authentik hop). It ships independently of the touch-scroll work
(t051) and of the deferred codec work: it layers above the screencast and reuses
the existing coordinate pipeline, so it carries no transport risk. With t051
feeding finger gestures into the same mouse pipeline, the echo cursor is what
makes finger input legible (the OS cursor isn't always present under a touch
point on iPad). It's an inner-ring input-feel task with no dependents waiting on
it, but it's a direct contributor to the "instant" bar the gate is judged on.

## Acceptance criteria

- [ ] An echo cursor overlay renders on the viewport at the live pointer/touch
      position and updates on every `pointermove` with no wait for a remote
      frame — visibly ahead of the screencast's own cursor on a throttled link.
- [ ] The echo cursor is driven by the **same** client coordinates the Input
      Forwarding path uses (one mapping, computed once) — the echo never diverges
      from where the click is actually sent.
- [ ] On press (mouse down / tap / long-press), an optimistic press affordance
      flashes at the cursor position immediately, then clears on its own short
      timeout — independent of any remote acknowledgement.
- [ ] The echo cursor hides when the pointer leaves the viewport and on
      disconnect; it does not linger as a stale dot over a frozen frame.
- [ ] All position / show-hide / press-state decisions live in a pure
      `src/lib/echo-cursor.ts` module with no DOM or Canvas access; the viewport
      component only renders what the module returns.
- [ ] The overlay layers cleanly above the screencast via the existing
      `paintSource` Canvas path (any `CanvasImageSource`) or a sibling overlay —
      no new native view, no z-order fight with React overlays, no jiggle on
      sidebar toggle or container resize.
- [ ] Disabled / inert when there is no live frame (loading, error, no tab) — the
      echo cursor never paints over an empty/black viewport as if input were live.
- [ ] `pnpm check` (touched files) / `pnpm typecheck` / `pnpm test` green.

## Test plan

### Layer 1 — Pure logic (TDD)

- [ ] `echo-cursor.ts` `reduce`/position mapping — a `pointermove` at client
      `(x, y)` over a known canvas rect produces the cursor overlay position the
      draw path should render at (same geometry the hit-test uses; round-trips
      against `toRemoteCoords`'s inverse for a synthetic snapshot).
- [ ] `echo-cursor.ts` show/hide — `enter` shows, `leave` hides, `disconnect`
      hides; a move while hidden after `leave` does not re-show until the next
      `enter`.
- [ ] `echo-cursor.ts` press state — `press` sets an active press affordance with
      its position; the affordance auto-clears after the configured duration
      (driven by an injected `now`, not a real timer, so the test is
      deterministic); a second press while one is active replaces it.
- [ ] `echo-cursor.ts` no-frame gate — with `hasFrame: false` the model reports
      the cursor inert (nothing to render) regardless of move/press events.

### Layer 2 — Manual smoke (CDP/IPC)

n/a — no main-process or IPC code is touched. The overlay is renderer-only and
reuses coordinates already computed for forwarding; the server/transport is not
involved.

### Layer 3 — Visual review

- [ ] Screenshots captured via Chrome MCP against `pnpm dev` (and `pnpm web`):
      echo cursor tracks the pointer; press affordance flashes on click.
- [ ] All four states visible: loading (no echo cursor — no live frame), empty
      (no echo cursor), error (no echo cursor), populated (echo cursor + press
      affordance live over the screencast).
- [ ] **Simulated latency** (Chrome DevTools network/CPU throttling or an
      artificial frame delay): the echo cursor is visibly *ahead* of the remote
      frame's cursor; the press affordance fires before the remote click lands.
- [ ] Sidebar toggle + container resize while the echo cursor is visible: the
      overlay stays glued to the pointer with no jiggle, lag, or stale position.
- [ ] **HITL — iPad PWA (physical):** finger move shows the echo cursor under the
      touch point; tap flashes the press affordance instantly on the couch link.
      Magic Keyboard trackpad pointer also shows it. (Physical-device check —
      cannot be done from desktop Chrome.)

## Design notes

The echo cursor is a presentation-only overlay: it renders the *intent* the user
already expressed (pointer position, press) before the Remote Page can confirm
it. It must read from the exact same coordinate source as Input Forwarding so the
dot and the click can never separate.

- **New modules:** `src/lib/echo-cursor.ts` — a pure state container for the echo
  cursor. It owns the overlay model (cursor `{x, y}` in canvas space, visible
  flag, active press affordance with an expiry) and a `reduce(state, event)`
  over `enter | move | leave | press | disconnect | frame-state` events, plus an
  injected `now` for deterministic press-expiry. Justification: this is exactly
  the "pure logic for `src/lib/`, strict TDD" class — keeping show/hide/expiry
  decisions out of the component makes the felt-latency behavior testable without
  a canvas, matching the Viewport Transform / Adaptive Viewport split already in
  the codebase.
- **Contracts changed:** none in `src/lib` public transport/page contracts. In
  `src/components/viewport.tsx` the existing `onMouseMove`/`onMouseDown`/
  `onMouseUp` (and the touch path t051 adds) feed `echo-cursor.ts` with the same
  client coordinates already passed to `page.forwardInput`; the component renders
  the overlay the module returns. The overlay reuses the `paintSource`
  (`CanvasImageSource`) Canvas path or a sibling absolutely-positioned element
  layered above the canvas via z-index — both already-supported in the viewport
  (see ADR-0005 on overlays stacking above the live page by CSS z-index, never
  native z-order).
- **New ADR needed?** no — this is a presentation overlay over the existing
  Viewport Transform geometry and Input Forwarding coordinates; no new
  architectural decision. (Builds directly on done t026's single frame-view
  snapshot + `toRemoteCoords` geometry and done t014's coordinate mapping.)

```ts
// pure: the echo cursor model, no DOM/Canvas inside the lib
interface EchoCursor {
  pos: { x: number; y: number } | null   // canvas-space cursor position; null = hidden
  press: { x: number; y: number; until: number } | null // optimistic press flash + expiry
}
type EchoEvent =
  | { type: "enter" | "leave" | "disconnect" }
  | { type: "move"; pos: { x: number; y: number } }
  | { type: "press"; pos: { x: number; y: number } }
  | { type: "frame-state"; hasFrame: boolean } // gate: no live frame -> inert
function reduce(state: EchoCursor, event: EchoEvent, now: number): EchoCursor
// component: feed the same client coords used for forwarding; render `pos` + active `press`
```

## Out of scope

- Touch-scroll / tap / long-press *gesture* detection itself — that's t051; this
  task only renders the echo + press for whatever press/move events arrive
  (mouse today, finger once t051 lands).
- The latency codec (WebRTC / WebCodecs) and any transport change — deferred to
  v0.2; the echo cursor is the cheap, transport-free felt-latency win for v0.1.0.
- The always-on RTT/jitter metrics + latency HUD (t057 / outer-ring t059) — the
  echo cursor does not read or display measured latency, it just removes the
  wait.
- Optimistic *content* prediction (text echo, scroll prediction, drag preview) —
  only the cursor and press affordance are optimistic here.
- Server-side or remote cursor rendering — this is purely a local overlay; the
  remote frame remains the source of truth and confirms a beat later.

## Definition of Done

All must be true before status → done.

- [ ] Layer 1 tests written and green (if pure logic was touched)
- [ ] Layer 2 smoke checklist completed with a live Remote Browser (if main.js/IPC touched)
- [ ] Layer 3 screenshots captured and committed (if UI touched)
- [ ] `pnpm check` clean (Biome — lint + format)
- [ ] `pnpm typecheck` clean
- [ ] `pnpm test` green
- [ ] `pnpm dev` boots cleanly and the changed surface works end-to-end
- [ ] CLAUDE.md updated for any modified module (note the echo cursor under the
      Viewport Transform / Input Forwarding description; add `echo-cursor.ts` to
      the `src/lib` listing)
- [ ] ADR written if an architectural decision was made (none expected)
- [ ] No commented-out code, no `console.log` debris, no AI attribution
- [ ] Task closed: status → done, file moved to `docs/tasks/done/`, tNNN in commit

## Notes

Write the press-expiry test first with an injected `now` and let it fail before
implementing — the auto-clear is the part most likely to leak a real timer into
the pure module. Render the overlay from the same coordinates already handed to
`page.forwardInput` in `viewport.tsx` (don't recompute a second mapping) so the
echo and the click provably share one source of truth — the divergence is the
bug class t026 already fought on the draw/input geometry. Keep the affordance
subtle (a small ring/dot, short flash) — it's a latency cue, not a click
animation; over-designing it makes a slow link feel busier, not faster. On the
iPad PWA the echo cursor doubles as the *only* visible pointer under a finger, so
its show/hide on `enter`/`leave` is what keeps it from lingering as a stale dot.

---

_When task status flips to `done`, move this file to `done/`._
