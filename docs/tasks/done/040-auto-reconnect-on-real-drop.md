# 040 — bounded-backoff auto-reconnect on real connection drop

- **Status:** done
- **Mode:** HITL
- **Estimate:** 1d
- **Slice:** 1-never-stuck
- **Ring:** inner
- **Depends on:** fix-spurious-disconnect-on-switch (t039)
- **Blocks:** none

## Goal

When the link to the Remote Browser genuinely drops mid-session — the CDP Host restarts, the network blips, the proxy reaps an idle socket — the app today freezes on the last Screencast Frame and stays stuck. The user has to notice, give up, and reload. After this task, a real drop (not an intentional Tab switch) kicks off an automatic reconnect with **bounded exponential backoff**: it retries the connect on a growing-then-capped cadence, surfaces a plain "Reconnecting…" status while it works, and silently recovers the live page the moment the Host comes back — no reload, no user action. The backoff schedule itself (the delay sequence, the cap, reset-on-success, the max-attempt ceiling) is a tiny pure module under test; the wiring lives in the connector / web transport and reuses the existing `connectId` race-guard so a reconnect that overlaps a Tab switch cancels cleanly instead of racing.

## Why now

This is the load-bearing item on the **1-never-stuck** slice and a direct obligation of [product.md](../conventions/product.md)'s never-stuck contract: a daily-driver iPad PWA must self-heal without the user babysitting it. The first network hiccup of the morning — closing the laptop lid the Host runs on, switching the iPad off Wi-Fi onto cellular, the proxy idle-reaping a quiet socket — currently ends the session until a manual reload. That fails the v0.1.0 gate ("I'd want to use this all day"). This task depends on t039 because auto-reconnect is only safe on a **trustworthy** drop signal: t039 stops the spurious `disconnected` broadcast that fires on every Tab switch, so the reconnect loop here triggers on real drops only and never thrashes on a normal switch. It is also the foundation t041 (foregrounded WS re-climb) and t042 (one-tap manual Reconnect) build on — both reuse this task's backoff state rather than spinning competing loops.

## Acceptance criteria

- [ ] A pure backoff module (`src/lib/reconnect-backoff.ts`) computes the delay schedule: each successive attempt's delay grows (exponential, e.g. base × 2ⁿ), is **capped** at a ceiling, and the sequence **resets to the base delay on a successful connect**.
- [ ] The schedule honors a **max-attempts** (or max-elapsed) ceiling: after the ceiling the loop stops retrying and the status settles on a terminal "Disconnected — Reconnect" state rather than retrying forever in a tight loop.
- [ ] The module is I/O-free: no `setTimeout`, no `WebSocket`, no `fetch`, no `document`. It is a pure function/state-machine over `(attempt, lastOutcome)` → `{ delayMs, give_up }`; the timer that *waits* `delayMs` and re-invokes `connect` lives in the effectful wiring, not here.
- [ ] A **real drop** (the `disconnected` signal that survives t039's fix — Remote Page socket closed without a host-initiated `disconnect()`) triggers the reconnect loop. An **intentional Tab switch / host-initiated `disconnect()`** does **not** trigger it.
- [ ] On reconnect, the existing `connectId` race-guard is reused: a reconnect attempt that resolves after a newer `connect` (e.g. the user switched Tabs while a retry was in flight) has its socket closed and discarded — never promoted, never emits frames. No second live socket; no duplicate `onEvent`/`onClose` listeners after recovery.
- [ ] A successful reconnect re-runs the full connect choreography (activate → resolve → `Page.enable`/`Input.enable` → theme emulation → cached Adaptive Viewport device-metrics re-apply → `startScreencast`) via the connector, so the recovered page is fully live, not a half-attached socket. The backoff state resets on that success.
- [ ] The status bar shows **"Reconnecting…"** (with attempt cadence visible as a spinner, not an error) while the loop runs, and clears back to live the instant a reconnect succeeds; after the max-attempts ceiling it shows a terminal "Disconnected" state with the existing Connection-settings affordance.
- [ ] Behavior-preserving when the link never drops: a session with no real drop sees zero new behavior — no extra reconnect attempts, no status flicker.

## Test plan

Per [../conventions/tdd.md](../conventions/tdd.md): the backoff schedule is pure logic → strict TDD (Layer 1). The drop→retry wiring is CDP/WS glue → manual smoke against a live Host (Layer 2). The status-bar transition is a small renderer change → visual review (Layer 3).

### Layer 1 — Pure logic (TDD)

- [ ] `reconnect-backoff.ts` — delay schedule: successive attempts grow exponentially from a base delay (assert the first N delays, e.g. 0.5s → 1s → 2s → 4s …).
- [ ] `reconnect-backoff.ts` — the delay is **capped** at the ceiling: attempts past the knee all return the cap, never an unbounded value.
- [ ] `reconnect-backoff.ts` — **reset-on-success**: feeding a success outcome resets the next delay to the base (the sequence does not stay pinned at the cap after recovery).
- [ ] `reconnect-backoff.ts` — **max-attempts ceiling**: after the configured attempt budget the schedule reports `give_up` (terminal), and no further delay is produced.
- [ ] `reconnect-backoff.ts` — the module is pure: no timers / sockets / DOM inside; `attempt` count and `lastOutcome` are injected inputs, the verdict is returned, never enacted.

### Layer 2 — Manual smoke (CDP/IPC)

HITL — needs a live Remote Browser via `pnpm web` (ideally through the deployment to exercise the real proxy chain, where idle-socket reaps actually happen).

- [ ] Connect to the Host; confirm the Active Tab renders frames and accepts input.
- [ ] **Kill the CDP Host mid-session.** The status bar shows "Reconnecting…"; the network panel / server logs show retry attempts on a **growing-then-capped** cadence (not a tight loop, not a storm).
- [ ] **Restart the Host.** Within one backoff window the page auto-recovers — frames resume, input works, Adaptive Viewport metrics re-applied if enabled — **with no reload**. The backoff resets (a subsequent drop starts again from the base delay).
- [ ] Leave the Host down past the max-attempts ceiling: confirm the loop **stops** and the status settles on a terminal "Disconnected — Connection settings" state instead of retrying forever.
- [ ] **Switch Tabs rapidly** while a reconnect is in flight (drop the Host, then immediately switch): the reconnect attempt does not promote a stale socket over the Tab you landed on — the `connectId` race-guard holds; exactly one live screencast in CDP `/json` after it settles.
- [ ] Confirm a **normal Tab switch with the Host healthy** does **not** trigger the reconnect loop or flash "Reconnecting…" (t039's fix is the precondition — verify the drop signal is real-drop-only).

### Layer 3 — Visual review

- [ ] Screenshots via Chrome DevTools against `pnpm web` running locally (desktop web is acceptable for the status-bar state transitions).
- [ ] The status bar shows the sequence **live → "Reconnecting…" (spinner, not error styling) → live** across a simulated drop/recover, and the terminal **"Disconnected"** state after the ceiling.
- [ ] No stuck "Reconnecting…" badge once the socket is back; no error-red styling for the in-progress reconnect (it is progress, not failure).
- [ ] iPad-physical confirmation (lid-close the Host machine / flip Wi-Fi off→on on the iPad PWA, then watch it self-heal) is **HITL** — covered by the t018 gate.

## Design notes

The reconnect splits into a **pure schedule** and an **effectful loop**, matching the project's pure-advisor / effectful-executor discipline (same shape t041 then reuses). The schedule decides *how long to wait and whether to give up*; the loop waits and re-invokes the connector's `connect`.

- **`src/lib/reconnect-backoff.ts`** *(new)* — the only new module. A tiny pure state machine: `next(state, outcome) → { delayMs, give_up, state }` over an attempt counter, with config `{ baseMs, factor, capMs, maxAttempts }`. Exponential growth, hard cap, reset on success, terminal on ceiling. No I/O — the timer lives in the caller. Justified as its own module so the cadence is exercisable without sockets and so t041/t042 compose with the same backoff state instead of duplicating a retry counter.
- **`remote-page-connector.js`** — the connector already owns the single live socket, the `connectId` race-guard, and emits `onClose`. This task wires the reconnect loop to that `onClose` (the real-drop signal that survives t039): on a non-host-initiated close, drive the backoff loop, calling `connect({ tabId })` after each `delayMs`. Reuse the existing `connectId` guard so an overlapping Tab switch cancels an in-flight retry (a retry resolving after a newer `connect` is discarded, exactly as today). The connector gains a small reconnect driver (or accepts an injected one) but its `connect`/`disconnect` contract is unchanged; `disconnect()` must cancel any pending backoff timer (host-initiated teardown stops the loop).
- **`src/lib/cdp-web-transport.ts`** — the web assembler already surfaces the `disconnected` event through the Dispatcher and exposes `onDisconnected`. The reconnect loop hangs off that real-drop signal on the web path; the recovered socket re-feeds the single Downlink source and the Uplink command path with no second socket (same one-source guarantee t029 established). The exposed `CdpBridge` surface and `onDisconnected` callback are unchanged — the renderer just sees the status flip and then live frames again.
- **`src/components/status-bar.tsx`** — add the **"Reconnecting…"** transient state. Today the bar derives error vs idle vs progress from `loadingText`; the reconnect state is **progress styling** (spinner, muted — not the red error path), and the terminal post-ceiling state reuses the existing error/Connection-settings affordance. Driven by the same `loading` / status props the bar already consumes — no new wiring contract, just an additional recognized status string.

- **Contracts changed:** none externally. `CdpBridge` is unchanged; the connector's `connect`/`disconnect` signatures are unchanged. New pure module `reconnect-backoff.ts`; the connector internally gains a reconnect driver bound to its existing `onClose` + `connectId`.
- **New modules:** `src/lib/reconnect-backoff.ts` — pure backoff schedule (delay/cap/reset/give-up). Nothing else.
- **New ADR needed?** No. This realizes the self-healing reconnect that ADR-0001 (single Remote Page) + the t029 connector deliberately left a single home to grow into; the connector centralized the seam *so* reconnect could land here. If the backoff defaults or give-up policy turn out to warrant a recorded decision, append an addendum to the connector's ADR rather than opening a new one.

```ts
// pure schedule — all inputs injected, no I/O
interface BackoffConfig {
  baseMs: number      // first retry delay
  factor: number      // growth multiplier (e.g. 2)
  capMs: number       // ceiling — delays never exceed this
  maxAttempts: number // give up after this many tries
}
type Outcome = "drop" | "success"

interface BackoffStep {
  delayMs: number  // how long to wait before the next connect attempt
  giveUp: boolean  // ceiling reached → stop, settle terminal "Disconnected"
}

// success resets the attempt counter to base; the caller owns the timer + connect call
function nextBackoff(state: BackoffState, outcome: Outcome, cfg: BackoffConfig): {
  state: BackoffState
  step: BackoffStep
}
```

## Out of scope

- The **foregrounded WS re-climb on a timer** — that is **t041** (`ws-auto-reconnect-while-visible`), which depends on this task and reuses this backoff state. This task lands the real-drop detection + bounded backoff; t041 layers the visible-tab re-climb on top.
- **One-tap manual Reconnect** in the status bar / settings — that is **t042**; it reuses this loop's `connect` entry point and backoff reset, but the manual control itself is out of scope here.
- Fixing the **spurious disconnect signal** — that is **t039** (this task's dependency); this task consumes the corrected real-drop signal, it does not produce it.
- Reconnect for the **SSE+POST fallback** request paths — those re-establish per request; only the long-lived Remote Page socket needs this backoff loop.
- **Adopting the connector into `main.js`** — the t032 connector-adoption refactor is deferred to v0.2; this task wires reconnect on the web/connector path that already consumes it. (If the Electron main path needs the same loop before t032 lands, that is a follow-up, not this task.)
- The **latency HUD / metrics surfacing** (latency-hud-status-bar, OUTER ring) and the **WebRTC/WebCodecs codec** path (deferred v0.2).

## Definition of Done

All must be true before status → done.

- [ ] Layer 1 tests written and green (the `reconnect-backoff.ts` schedule: growth, cap, reset-on-success, give-up)
- [ ] Layer 2 smoke checklist completed with a live Remote Browser via `pnpm web` (kill/restart Host → auto-recover; ceiling → terminal; race-guard under rapid switch)
- [ ] Layer 3 screenshots captured and committed (live → Reconnecting… → live; terminal Disconnected)
- [ ] `pnpm check` clean (Biome — lint + format)
- [ ] `pnpm typecheck` clean
- [ ] `pnpm test` green
- [ ] `pnpm web` boots cleanly and the page self-heals end-to-end after a real drop
- [ ] CLAUDE.md updated for any modified module (`src/lib/CLAUDE.md` notes the new `reconnect-backoff.ts`; the connector's role as reconnect owner is reflected)
- [ ] ADR written if an architectural decision was made (expected: none — addendum to the connector ADR only if backoff/give-up policy warrants it)
- [ ] No commented-out code, no `console.log` debris, no AI attribution
- [ ] Task closed: status → done, file moved to `docs/tasks/done/`, t040 in commit

## Notes

- Hard precondition: **t039 must land first.** Auto-reconnect on an untrustworthy drop signal would thrash on every normal Tab switch — the whole point is to act only on a *real* drop. Verify the real-drop-only behavior explicitly in Layer 2.
- Do not introduce a competing retry loop: this task owns *the* backoff state; t041 (visible-tab re-climb) and t042 (manual Reconnect) must compose with it, not duplicate the counter. Keep the schedule in `reconnect-backoff.ts` so all three share one source of truth.
- Reuse the connector's existing `connectId` race-guard verbatim — the bug class it kills (a slow reconnect from a just-abandoned state promoting its socket over the Tab the user landed on) is exactly what an automatic retry could resurrect. The retry path must flow through the same guard, not around it.
- `disconnect()` (host-initiated) must cancel any pending backoff timer — a manual disconnect / intentional teardown stops the loop; it must not race a queued retry back to life.
- "Reconnecting…" is **progress**, not an error — spinner + muted styling, not the red error path. Only the post-ceiling terminal state uses the error/Connection-settings affordance.
- Smoke ideally runs through the real proxy chain (the deployment): a proxy idle-socket reap is a canonical real drop and only reproduces under the real chain.

---

_When task status flips to `done`, move this file to `done/`._
