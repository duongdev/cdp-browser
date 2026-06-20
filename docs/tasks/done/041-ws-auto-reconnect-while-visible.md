# 041 — timer WS reconnect while foregrounded

- **Status:** done
- **Mode:** HITL
- **Estimate:** 1d
- **Slice:** 1-never-stuck
- **Ring:** inner
- **Depends on:** auto-reconnect-on-real-drop (t040)
- **Blocks:** none

## Goal

The web build's WebSocket transport — the fast path that carries frames, events, and input over one socket — currently does not climb back to WS on its own after a mid-session blip while the PWA stays foregrounded. A silent WS drop (idle socket reaped by the proxy, a network change on the iPad) leaves the user demoted to SSE+POST for the rest of the session with no path back to the fast lane short of a reload. After this task, while the document is visible a bounded timer re-attempts the WS transport whenever it is down, restoring the fast path within a few seconds of a blip — and it never fires while the tab is backgrounded, so a parked PWA does not hammer the server.

## Why now

This is an inner-ring item on the **1-never-stuck** slice: the v0.1.0 gate is "I'd want to use this all day on the iPad." A daily driver that quietly degrades to the slow transport after the first network hiccup of the morning and stays there fails that bar — the user feels the input lag and has no idea a reload would fix it. t040 lands the real-drop detection + bounded backoff on the WS source; this task layers the *foregrounded re-climb* on top so recovery is automatic, not manual. It is the last piece that makes WS self-healing rather than one-shot, which is what the never-stuck promise requires.

## Acceptance criteria

- [ ] A pure `shouldReconnect(state)` predicate exists: returns `true` when the document is **visible** AND the WS transport is **down** (not connected, not already mid-attempt); returns `false` when backgrounded, when WS is already up, or when an attempt is in flight.
- [ ] While the document is visible and WS is down, a timer re-attempts the WS transport on a bounded interval; a successful attempt stops the timer (WS is up again).
- [ ] The timer respects `visibilitychange`: it does not run (no reconnect attempts) while `document.visibilityState === "hidden"`; it resumes on return to visible.
- [ ] Backoff is honored — the re-attempt cadence builds on t040's backoff rather than introducing a second, competing retry loop. No reconnect storm: at most one attempt in flight, and attempts are spaced (not a tight loop) while down.
- [ ] The re-climb only applies when WS is the intended transport (Auto, or a manual WS/Fastest pick). It does not force WS when the user has manually picked Streaming or Basic, and it does not fight the `transport-selector.ts` advised mode.
- [ ] When WS comes back, the Downlink event source and the Uplink command path both resume on the single restored socket (no second socket, no duplicate listeners).
- [ ] The active-transport indicator returns to WS / Fastest after the blip heals (no stale "degraded" state once the socket is back).
- [ ] Behavior-preserving for the SSE+POST-only path: environments where WS never opens see no new behavior — the timer attempts, fails, and the user keeps running on the fallback exactly as before.

## Test plan

### Layer 1 — Pure logic (TDD)

- [ ] `shouldReconnect` predicate — visible + ws-down + no attempt-in-flight → `true`
- [ ] `shouldReconnect` predicate — `hidden` (backgrounded) → `false` even when ws is down
- [ ] `shouldReconnect` predicate — ws already up → `false`
- [ ] `shouldReconnect` predicate — attempt already in flight → `false` (no second concurrent attempt)
- [ ] `shouldReconnect` predicate — manual non-WS pick (Streaming/Basic) → `false` (don't force WS over a user choice)
- [ ] Interval/cadence logic — successive down ticks back off (delegates to / composes with t040's backoff, no independent tight loop); a success resets it
- [ ] The predicate stays pure: no `WebSocket`, no `fetch`, no `document` access inside the tested module — visibility and ws-state are injected inputs

### Layer 2 — Manual smoke (CDP/IPC)

HITL — needs a live Remote Browser via `pnpm web`, ideally through the deployment to exercise the real proxy chain.

- [ ] Boot `web/server.mjs`, connect on **Auto** so WS is the active path; confirm frames + input ride WS (one socket in the network panel).
- [ ] Drop the WS upstream mid-session (kill/restart the proxy WS hop, or pull/restore the network) while the page is **foregrounded** — within a few seconds the timer re-establishes WS and the fast path self-heals; input latency returns to the WS floor without a reload.
- [ ] Repeat with the tab/PWA **backgrounded** during the drop — confirm **no** reconnect attempts fire while hidden (watch the network panel / server logs for an attempt storm), and that returning to foreground triggers a single clean re-attempt.
- [ ] Manually pick **Basic** (or Streaming), then drop WS — confirm the timer does **not** force a WS re-climb against the manual choice.
- [ ] In a WS-hostile environment (revert the nginx three-line fix), confirm the timer attempts and fails quietly, leaving the user on SSE+POST with no storm.

### Layer 3 — Visual review

- [ ] Screenshots / observation via Chrome DevTools against `pnpm web` running locally (desktop web is acceptable for the indicator transition).
- [ ] The active-transport / connection-mode indicator shows the blip and the return to WS/Fastest (degraded → recovered), with no stuck "degraded" badge after recovery.
- [ ] iPad-physical confirmation of the foreground/background reconnect behavior (lock screen / app-switch the PWA, then return) is **HITL** — covered by the t018 gate.

## Design notes

The reconnect logic splits into a pure decision and an effectful timer, matching the existing web-transport seam discipline (pure advisor + effectful executor).

- **`src/lib/transport-selector.ts`** — host the pure `shouldReconnect(state)` predicate and the cadence/backoff composition. It already owns the Auto chain, retry bounds, last-good cache, and the degraded → re-probe-on-focus transition; the visible-tab re-climb is the same family of advice — visibility + ws-readiness in, "attempt now / wait" out. It stays I/O-free: visibility state and ws-up/attempt-in-flight are injected, never read from `document`/`WebSocket` inside the module. This builds directly on t040's backoff state rather than adding a parallel retry counter.
- **`src/lib/downlink-dispatcher.ts`** — the Downlink source already tears down fully on close and exposes `onClose`. The timer-driven re-attempt re-creates the WS-backed `DownlinkSource` and swaps it in as the single live source, so a restored socket re-feeds the dispatcher with no duplicate listeners. No contract change to `Downlink`/`Dispatcher` — the re-attempt reuses the existing "exactly one live source, switching tears the prior down" guarantee.
- **`src/lib/uplink-router.ts`** — the WS adapter is the same socket shared with the Downlink (one socket, two seams). When WS re-opens, the router's WS adapter reports `isReady()` again and the advised-mode pick returns to WS automatically; the router needs no new branch — it consumes the selector's advice exactly as today.

The effectful timer itself — the `setInterval`/`setTimeout` loop, the `visibilitychange` listener, and the actual WS-open call — lives with the existing transport effects in `cdp-web-transport.ts` (it holds the socket and the DOM), driven by the pure `shouldReconnect` verdict. The selector advises; the assembler acts. This keeps the tested state machine free of timers and DOM.

- **Contracts changed:** none externally. `CdpBridge` is unchanged; the picker UI and persisted `inputTransport` setting are untouched. New pure helper(s) added to `transport-selector.ts`; no new public type leaves the module.
- **New modules:** none — the predicate lands in the existing `transport-selector.ts`.
- **New ADR needed?** No. This realizes the self-healing WS path already sanctioned by ADR-0007 (which deferred mid-session climb-back as a follow-up — t040 + this task close that gap). If the visible-tab reconnect materially diverges from ADR-0007's description, append an addendum there rather than opening a new ADR.

```ts
// pure verdict — all inputs injected, no I/O
interface ReconnectState {
  visible: boolean        // document.visibilityState === "visible"
  wsUp: boolean           // the shared WS socket is open and ready
  attemptInFlight: boolean
  intendsWs: boolean      // advised mode is ws (Auto resolving to ws, or manual Fastest)
}

function shouldReconnect(s: ReconnectState): boolean
// true  ⇔ s.visible && s.intendsWs && !s.wsUp && !s.attemptInFlight
```

## Out of scope

- The real-drop detection + bounded backoff itself — that is **t040** (`auto-reconnect-on-real-drop`), this task's dependency. This task only adds the foregrounded re-climb on top.
- Any change to the Auto/WS/Stream/Basic picker UI, its tooltips, or the persisted `inputTransport` setting (t019 surface).
- Reconnect for the SSE+POST fallback paths — those already re-establish per request; only the long-lived WS source needs a re-climb timer.
- The latency HUD / metrics surfacing (latency-hud-status-bar, OUTER ring) — the indicator transition here reuses the existing connection-mode badge, not a new HUD.
- Mid-session transport swap on a *manual picker change* — already handled by t019's reconnect-within-~1s; this task is about recovering the active intended transport, not switching modes.
- Refactoring `main.js` onto the shared core (t032, deferred to v0.2).
- The WebRTC/WebCodecs codec path (deferred to v0.2).

## Definition of Done

All must be true before status → done.

- [ ] Layer 1 tests written and green (the `shouldReconnect` predicate + cadence cases)
- [ ] Layer 2 smoke checklist completed with a live Remote Browser via `pnpm web` (foreground heal + backgrounded no-storm verified)
- [ ] Layer 3 screenshots / indicator transition captured and committed
- [ ] `pnpm check` clean (Biome — lint + format)
- [ ] `pnpm typecheck` clean
- [ ] `pnpm test` green
- [ ] `pnpm web` boots cleanly and the WS path self-heals end-to-end after a blip
- [ ] CLAUDE.md updated for any modified module (`src/lib/CLAUDE.md` notes the visible-tab re-climb on `transport-selector.ts`)
- [ ] ADR written if an architectural decision was made (expected: none — addendum to ADR-0007 only if the seam diverges)
- [ ] No commented-out code, no `console.log` debris, no AI attribution
- [ ] Task closed: status → done, file moved to `docs/tasks/done/`, t041 in commit

## Notes

- Hard constraint: do not introduce a second retry loop that competes with t040's backoff. The visible-tab timer must *compose with* the existing backoff state in `transport-selector.ts`, not duplicate the retry counter — otherwise two loops race and the cadence is unpredictable.
- One socket, two seams: the restored WS feeds both the Downlink (frames + events) and the Uplink (input) on the same connection. Verify in the network panel that exactly one WS appears after a heal — a second socket means the re-attempt leaked the prior source.
- Visibility gate must key off real `visibilitychange` (and `document.visibilityState`), not a synthesized/focus-only signal — backgrounding the PWA on iOS hides it; the timer must go quiet there to avoid draining battery / hammering the proxy.
- Smoke should run through the real proxy chain (the deployment) where possible — an idle-WS reap by the proxy is exactly the blip this recovers from, and it only reproduces under the real chain.

---

_When task status flips to `done`, move this file to `done/`._
