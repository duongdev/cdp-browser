# 054 — cap everyNthFrame + server frame-rate throttle to stop stale-frame pile-up

- **Status:** done
- **Mode:** HITL
- **Ring:** inner
- **Slice:** 4-table-stakes-latency
- **Category:** latency
- **Effort:** S
- **Estimate:** 0.5d
- **Depends on:** none
- **Blocks:** 055 (Sharp/Balanced/Snappy quality-latency tier picker)

## Goal

On a slow link the screencast keeps emitting frames faster than the link can drain them, so frames queue up and the iPad PWA paints **stale** frames — the cursor and page lag visibly behind reality. After this task, `Page.startScreencast` caps `everyNthFrame` and the server enforces a frame-rate ceiling so the remote browser produces fewer, fresher frames instead of a backlog. The cap lives in the backend-agnostic Remote Page connector so the web build (priority surface) and Electron get the same behavior. The user-perceived result: on a constrained connection the page still moves, but what's on screen is *current*, not a replay of where the cursor was a second ago.

## Why now

Stale-frame pile-up is the single biggest cheap source of perceived lag on the daily-driver iPad PWA, and it's a v0.1.0 inner-ring gate item (Slice 4 table-stakes latency). It's also the **foundation the quality-tier picker (t055) keys off**: Sharp/Balanced/Snappy can't tune frame rate vs quality until there is a frame-rate cap to tune. We're explicitly *not* doing a codec swap (WebRTC/WebCodecs) for v0.1.0 — that's a data-driven v0.2 call — so the cheap throttle is what we ship now. Landing it before t055 keeps the tier picker a thin config layer over an already-working cap.

## Acceptance criteria

Each is checkable true/false at completion.

- [ ] `Page.startScreencast` is issued with an explicit `everyNthFrame` cap (≥ 1) instead of the implicit default; the value comes from one place in the connector, not duplicated per call site.
- [ ] The server enforces a frame-rate ceiling: when frames arrive faster than the configured target FPS, the excess is dropped (the freshest frame wins) rather than queued and broadcast late. A burst of frames on a fast link does not exceed the target rate downstream.
- [ ] The throttle keeps the freshest frame: when a newer frame arrives while an older one is being held, the older one is discarded — the client never receives an out-of-order or stale frame in preference to a newer available one.
- [ ] Frames are still acked correctly (`Page.screencastFrameAck`) for every frame the remote browser sends, including dropped ones, so the remote browser keeps producing (a dropped frame must still be acked or the screencast stalls).
- [ ] The cap/ceiling is **backend-agnostic**: defined in `remote-page-connector.js` and consumed by both `web/server.mjs` and `main.js` (main.js still holds an inline `startScreencast`; either route it through the connector value or mirror the same constant with a `// keep in sync with remote-page-connector.js` note — no silent divergence).
- [ ] Default values are conservative (no visible regression on a fast LAN link — full smoothness preserved); the throttle only bites when the link can't keep up.
- [ ] `pnpm test` covers the pure should-emit / throttle predicate (see Layer 1).

## Test plan

Per [../conventions/tdd.md](../conventions/tdd.md). The throttle decision is pure logic → strict TDD (Layer 1). The `startScreencast` param + ack wiring is CDP/WS glue → manual smoke (Layer 2). No renderer UI changes → Layer 3 n/a.

### Layer 1 — Pure logic (TDD)

Extract the rate decision into a tiny pure module (e.g. `frame-throttle.js` at the repo root, CJS, DI clock) — `createFrameThrottle({ targetFps, now })` returning `shouldEmit(frameArrivalTime)`:

- [ ] `frame-throttle.js` — first frame always emits.
- [ ] `frame-throttle.js` — a frame arriving before `1000 / targetFps` ms since the last emitted frame is suppressed (returns `false`).
- [ ] `frame-throttle.js` — a frame arriving after the interval emits and resets the window.
- [ ] `frame-throttle.js` — a burst of N frames within one interval emits exactly one (the freshest), not N.
- [ ] `frame-throttle.js` — `targetFps` of 0 / unset / Infinity means no throttle (every frame emits) — the fast-LAN no-regression path.
- [ ] `everyNthFrame` derivation (if computed from a target FPS) — covers the floor/clamp to ≥ 1.

### Layer 2 — Manual smoke (CDP/IPC)

HITL — needs a live Remote Browser. Run `pnpm web` against a reachable CDP Host (and `pnpm dev` for the Electron mirror if main.js is touched this session):

- [ ] Connect; on a fast link the screencast is visibly as smooth as before (no regression from the cap).
- [ ] Throttle the link (e.g. macOS Network Link Conditioner, or a constrained Tailscale/portal path) and drive the cursor around; confirm the canvas shows the *current* position with reduced frame rate rather than a backlog of stale frames catching up after you stop moving.
- [ ] Confirm the screencast does not stall under throttle — frames keep arriving (dropped frames are still acked; the stream never deadlocks waiting on an un-acked frame).
- [ ] In CDP `/json` confirm only one live screencast session (the throttle didn't change the single-Remote-Page invariant, ADR-0001).
- [ ] If main.js is touched: repeat the fast-link no-regression + throttled-link freshness checks in `pnpm dev`.

### Layer 3 — Visual review

- [ ] n/a — no renderer UI or layout changes. The Screencast canvas, sidebar, and toolbar are unchanged; frame freshness is observed via the Layer 2 web smoke, not a screenshot diff.

## Design notes

The change is a **rate ceiling on the producer + a fresh-frame-wins drop on the relay**, both sourced from one backend-agnostic place. Describe behavior, not line numbers:

- **Contracts changed:** `Page.startScreencast` params — old: `{ format, quality, maxWidth, maxHeight }` with no `everyNthFrame` (implicit Chromium default) → new: adds an explicit `everyNthFrame` cap. The connector already owns the `startScreencast` call for the web path (`createRemotePageConnector` in `remote-page-connector.js`, adopted by `web/server.mjs` via t029); add the cap there so web inherits it for free. `main.js` still has an inline `startScreencast` (its connector adoption is the deferred t032) — mirror the same value with a sync note rather than duplicating a magic number silently.
- **Frame relay:** `web/server.mjs` already acks each `Page.screencastFrame` itself (not from the client) and broadcasts to WS/SSE subscribers. Insert the throttle decision on the relay path: **ack every frame** (so the remote keeps producing) but only **broadcast** a frame when `shouldEmit` is true, dropping intermediate frames so subscribers get the freshest one at the target rate. Acking-but-dropping is the load-bearing detail — drop without ack and the screencast stalls.
- **New modules:** one repo-root CJS pure module `frame-throttle.js` (`createFrameThrottle({ targetFps, now })` → `shouldEmit()`), DI clock for testability. Justification: the rate decision is the only pure logic here and t055 will reuse it to map a quality tier → target FPS. Keeps the throttle unit-testable against a fake clock with zero CDP/WS dependency, consistent with the shared-CJS-core pattern (ADR-0008).
- **New ADR needed?** no — this is a tuning constant + a pure throttle, not an architectural decision. It preserves ADR-0001 (single Remote Page) and ADR-0002 (Adaptive Viewport metric re-apply happens before `startScreencast`, untouched). t055 may warrant an ADR for the tier model; this task does not.

```ts
// pure throttle contract — fresh-frame-wins, DI clock
interface FrameThrottle {
  // call per arriving Page.screencastFrame; true → broadcast, false → drop (still ack)
  shouldEmit(): boolean;
}
// createFrameThrottle({ targetFps, now }): FrameThrottle
// targetFps falsy / Infinity ⇒ shouldEmit always true (no-throttle, fast-LAN path)
```

## Out of scope

What this task explicitly does NOT do — capture as separate tasks if needed:

- **The Sharp/Balanced/Snappy quality-latency tier picker (t055)** — this task only lands the cap + throttle as a fixed conservative default with a single tuning point; the user-facing 3-tier picker that drives the target FPS/quality is t055 and depends on this.
- **Codec swap (WebRTC / WebCodecs) — deferred to v0.2** as a data-driven call. No transport/codec change here; we stay on JPEG screencast.
- **Client ack-after-paint backpressure (t056)** — one-frame-in-flight on the web path is a sibling latency item; this task is producer-side rate-capping + relay drop, not client-paced backpressure. They compose but ship separately.
- **Always-on RTT/jitter/frame-age metrics + HUD (t057/t059)** — measuring frame age is a separate task; this task reduces staleness, it does not surface a metric for it.
- **main.js connector adoption (t032, deferred v0.2)** — do not refactor main.js onto the connector here; just keep its inline `startScreencast` cap in sync with the connector value.

## Definition of Done

All must be true before status → done.

- [ ] Layer 1 tests written and green (the pure `frame-throttle.js` predicate)
- [ ] Layer 2 smoke checklist completed with a live Remote Browser (web; + Electron if main.js touched)
- [ ] Layer 3 screenshots captured and committed (n/a — no UI)
- [ ] `pnpm check` clean (Biome — lint + format)
- [ ] `pnpm typecheck` clean
- [ ] `pnpm test` green
- [ ] `pnpm dev` / `pnpm web` boots cleanly and the screencast works end-to-end on both a fast and a throttled link
- [ ] CLAUDE.md updated for any modified module (note the new `frame-throttle.js` core + the `everyNthFrame` cap in the connector)
- [ ] ADR written if an architectural decision was made (none expected for this task)
- [ ] No commented-out code, no `console.log` debris, no AI attribution
- [ ] Task closed: status → done, file moved to `docs/tasks/done/`, t054 in commit

## Notes

- The connector (`remote-page-connector.js`) is the single home for the web `startScreencast`; web inherits the cap automatically. main.js is the only duplicate left and its proper fix is the deferred t032 — keep the constant in sync with a comment for now, don't pre-empt t032.
- Ack-every-frame-but-drop-the-stale-ones is the invariant that keeps the stream alive under throttle; an un-acked dropped frame stalls the whole screencast. The Layer 2 smoke must explicitly confirm no stall under a throttled link.
- Pick conservative defaults: the cap must be invisible on a fast LAN (full smoothness) and only bite when the link can't drain frames. Tune the exact target FPS against a real throttled iPad/portal path during Layer 2.
- t055 reuses `frame-throttle.js` to map a quality tier → target FPS; keep the module free of any tier/UI knowledge — it only takes a `targetFps` number.

---

_When task status flips to `done`, move this file to `done/`._
