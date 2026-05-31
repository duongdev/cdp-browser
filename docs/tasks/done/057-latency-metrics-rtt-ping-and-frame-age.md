# 057 — always-on metrics: WS RTT/jitter ping estimator + server frame-age timestamp

- **Status:** done
- **Mode:** HITL
- **Ring:** inner
- **Slice:** 4-table-stakes-latency
- **Estimate:** 1d
- **Depends on:** none
- **Blocks:** 059 (toggleable latency HUD)

## Goal

Make link latency a measured number instead of a feeling. The web build gains two
always-on signals: (1) a **WS ping/pong RTT + jitter estimator** — the client stamps a
monotonic time on each ping, the server pongs it straight back, and the client folds the
round-trip into an EWMA RTT plus an EWMA jitter (mean absolute RTT deviation); the same
ping doubles as a **keepalive** so an idle WS isn't dropped by an upstream proxy. (2) A
**server-stamped frame timestamp** on every Screencast Frame envelope, so the client can
compute **frame age** (now − server send time, corrected for the one-way clock offset the
RTT probe already exposes). Both feed `perf-mark.ts` continuously and cost ~0 when nothing
reads them. The pure EWMA + frame-age math is unit-tested; this task ships the data layer,
not a visible HUD.

## Why now

This is an inner-ring v0.1.0 latency item under the locked Decision 4: metrics collection
is **always-on** in v0.1.0, building on `src/lib/perf-mark.ts`. "Feels laggy" today has no
number, a silent proxy demotion (WS → SSE) is invisible, and there is no signal to drive a
HUD or any future adaptive pacing. This task is the data layer the toggleable latency HUD
(t059, outer ring) renders — t059 is blocked until RTT/jitter/frame-age exist. The ping
keepalive also hardens the never-stuck story (an idle WS behind nginx/Authentik can be
reaped without traffic), which is squarely in the v0.1.0 gate.

## Acceptance criteria

- [ ] The client sends a periodic WS ping carrying a monotonic timestamp; the server
      replies with a pong echoing that timestamp unchanged. The pong round-trip updates an
      **EWMA RTT** and an **EWMA jitter** (mean absolute deviation of RTT), both readable as
      current values.
- [ ] The same ping acts as a **keepalive**: while the WS is open it fires on a fixed
      interval regardless of input/frame traffic, so an idle socket is not dropped by an
      upstream proxy. No ping/pong frames are dispatched as CDP events or surfaced to
      listeners (they are control traffic, not `cdp`/`notification` kinds).
- [ ] Every Screencast Frame envelope from the server carries a **server send timestamp**;
      the client computes **frame age** = `now − serverSendTs + clockOffset`, where
      `clockOffset` is derived from the RTT probe (one-way ≈ RTT/2). Frame age is recorded
      to `perf-mark` every frame, alongside the existing stage timings.
- [ ] Current RTT, jitter, and last frame-age are exposed to the renderer through a small
      read accessor (e.g. `getLatencySnapshot()`), so t059 can render them without re-deriving.
- [ ] Metrics collection is **always-on**: it runs without `?perf=1` / `localStorage.perf`,
      adds no per-frame allocation beyond the timestamp read, and is a no-op for listener
      fan-out (the ping/pong path never touches the dispatcher's `cdp` route).
- [ ] When the WS path is not active (SSE+POST fallback), the estimator degrades cleanly:
      RTT/jitter report "unavailable" rather than a stale or fabricated number, and frame age
      still computes from the server timestamp if the SSE frame envelope carries it (else
      reports unavailable).
- [ ] The frame timestamp is added in the **non-E2E binary path and the E2E sealed path**
      consistently — frame age is available whether or not E2E is on.
- [ ] `pnpm test` / `pnpm typecheck` / `pnpm check` (touched files) green.

## Test plan

### Layer 1 — Pure logic (TDD)

New pure module `src/lib/rtt-estimator.ts`. Strict TDD — write the tests first.

- [ ] `createRttEstimator` — first pong seeds RTT to the raw sample (no warm-up artifact);
      subsequent pongs fold in via EWMA toward the configured alpha.
- [ ] `createRttEstimator` — jitter is the EWMA of `abs(sample − rttBefore)`; a steady RTT
      drives jitter toward 0, an alternating RTT keeps jitter positive.
- [ ] `createRttEstimator` — an out-of-order / unknown pong timestamp (no matching outstanding
      ping) is ignored, not folded in.
- [ ] `createRttEstimator` — `snapshot()` reports `{ rtt, jitter, available: false }` before
      any pong and `available: true` after the first.
- [ ] `frameAge(nowMs, serverSendTs, clockOffsetMs)` — returns `now − serverSendTs + offset`;
      a negative result (clock skew / future stamp) clamps to 0 rather than going negative.
- [ ] `clockOffsetFromRtt(rtt)` — returns the one-way estimate (`rtt / 2`) used to correct
      frame age; 0 when RTT is unavailable.

### Layer 2 — Manual smoke (CDP/IPC) — HITL, needs a live Remote Browser

Run `pnpm web` against a live CDP host (the server change is in `web/server.mjs`):

- [ ] Boot the server, open the web build with WS reachable. Confirm ping frames go out on the
      interval and pongs return; the RTT snapshot stabilizes to a plausible value (a few ms
      tailnet-local, tens of ms over the public portal).
- [ ] Leave the tab idle (no mouse, no input) past the proxy idle timeout — the WS stays open
      (keepalive works), no spurious `disconnected`.
- [ ] Confirm frame age computes against the live link: it tracks RTT/2 + decode/queue time and
      does not drift unbounded (a clogged link makes it grow, a clear link keeps it low).
- [ ] Force SSE+POST (break WS at the proxy / pick "Streaming"): RTT/jitter report unavailable,
      no console errors, frame rendering unaffected.
- [ ] Repeat with `E2E_PASSPHRASE` set: frame age still computes (timestamp present on the
      sealed path), RTT/jitter unchanged.
- [ ] `node --check web/server.mjs` passes; the server boots cleanly (verify-locally-before-deploy).

### Layer 3 — Visual review

n/a — data layer only. There is no visible surface in this task; the HUD that renders these
numbers is t059 (outer ring).

## Design notes

Behavioral change, by contract — not file paths.

- **New module:** `src/lib/rtt-estimator.ts` — pure EWMA RTT + jitter estimator and the
  frame-age / clock-offset math. No timers, no WS, no I/O: it takes pong samples and `now`
  values as inputs and returns snapshots, so it is fully Layer-1 testable. The actual
  `setInterval` ping pump and the pong wiring live in the effectful transport layer
  (`uplink-router.ts` adapters send the ping; `downlink-dispatcher.ts` recognizes the pong),
  matching the pure-module invariant used across `src/lib/`.

  ```ts
  interface RttEstimator {
    onPing(seq: number, sentAtMs: number): void          // record an outstanding ping
    onPong(seq: number, nowMs: number): void             // fold the round-trip into EWMA
    snapshot(): { rtt: number; jitter: number; available: boolean }
  }
  function frameAge(nowMs: number, serverSendTs: number, clockOffsetMs: number): number
  function clockOffsetFromRtt(rtt: number | null): number
  ```

- **Contracts changed — Downlink (`downlink-dispatcher.ts`):** the inbound message union
  gains a control kind for `pong` that the dispatcher routes to the estimator and does **not**
  fan out as a `cdp`/`notification` event. The Screencast Frame envelope (already carried as a
  `cdp` event / binary `cdp-frame`) gains a server-send timestamp field the dispatcher hands to
  the frame-age recorder before fan-out. No public `CdpBridge` shape change for consumers.

- **Contracts changed — Uplink (`uplink-router.ts`):** the WS adapter sends a `ping` control
  frame on an interval (keepalive + RTT probe). Ping is control traffic, not an `UplinkCommand`,
  so the router's pick/fall-through logic is untouched — only the WS adapter owns the pump, and
  it runs only while the WS adapter is ready.

- **Contracts changed — server (`web/server.mjs`):** the WS message handler gains a `t: "ping"`
  branch that immediately replies `{ t: "pong", seq, ts }` echoing the client's monotonic stamp
  (server clock not trusted for RTT — only the client measures round-trip against its own clock).
  Every screencast-frame broadcast (`broadcastFrameBinary` / the sealed SSE frame path) stamps a
  server send time onto the envelope so the client can compute frame age. The frame timestamp is
  the server's wall clock; the RTT-derived one-way offset corrects client/server clock skew.

- **`perf-mark.ts`:** add a frame-age stage (and optionally RTT/jitter) to the existing tagged
  accumulator so the always-on collection lands in the same place as the `?perf=1` stage timings.
  The always-on RTT/jitter/frame-age snapshot is additionally exposed via the small read accessor
  (`getLatencySnapshot()`) that t059 consumes — `perf-mark`'s console flush stays gated on the
  existing `enabled` flag; the snapshot accessor does not.

- **New ADR needed?** No. This realizes Decision 4's always-on-metrics direction within the
  existing web-transport ADRs (0006 SSE+POST, 0007 WS). No new architectural boundary is created
  — it adds a control frame and a timestamp field to existing seams.

## Out of scope

- The visible **latency HUD** (RTT/jitter/transport in the status bar, off by default) — that
  is t059 (outer ring); this task only produces the numbers it reads.
- **Adaptive pacing / codec** (WebRTC / WebCodecs Phase 2–3) — deferred to a data-driven v0.2
  call (Decision 4). This task collects the data that decision will be made on; it does not act
  on it.
- The other cheap-win latency tasks: `everyNthFrame` cap + frame-rate throttle (t054),
  Sharp/Balanced/Snappy tier picker (t055), client ack-after-paint backpressure (t056),
  echo-cursor optimistic input (t052) — separate tasks in this slice.
- The `verify-proxy-buffering-config` documentation (t060, outer ring).
- Any NTP-grade clock sync — RTT/2 one-way correction is deliberately the cheap, good-enough
  estimate; we are not chasing absolute-time accuracy.

## Definition of Done

All must be true before status → done.

- [ ] Layer 1 tests written and green (the `rtt-estimator.ts` EWMA + frame-age suite).
- [ ] Layer 2 smoke checklist completed with a live Remote Browser (`pnpm web`, WS + SSE +
      E2E variants); `node --check web/server.mjs` clean.
- [ ] Layer 3 — n/a (data only, no UI surface).
- [ ] `pnpm check` clean (Biome — lint + format, touched files).
- [ ] `pnpm typecheck` clean.
- [ ] `pnpm test` green.
- [ ] `pnpm web` boots cleanly and the metrics compute against a live link.
- [ ] CLAUDE.md + `src/lib/CLAUDE.md` updated for the new `rtt-estimator.ts` module and the
      ping/pong + frame-timestamp additions to the Uplink/Downlink seams.
- [ ] No commented-out code, no `console.log` debris, no AI attribution.
- [ ] Task closed: status → done, file moved to `docs/tasks/done/`, t057 in commit.

## Notes

- Keep RTT measured **only on the client clock** (send-stamp → echo → receive-stamp); never
  diff client and server clocks for RTT. The server clock is used solely for the frame send
  timestamp, and the RTT/2 offset corrects the skew when computing frame age — so frame age
  stays meaningful even with an unsynced server clock.
- The keepalive interval should sit comfortably under typical proxy idle timeouts (nginx
  default is 60s) — a 15–25s ping is the usual safe band; pick one value, no setting.
- Outstanding-ping bookkeeping should be bounded (track the latest seq, drop stale/unknown
  pongs) so a flaky link can't grow an unbounded map.
- This pairs with t039 (stop spurious disconnect on switch): the keepalive must not be mistaken
  for, or interfere with, the connection-health signal — pong silence over several intervals is a
  link-quality signal for the HUD, not a `disconnected` trigger in this task.

---

_When task status flips to `done`, move this file to `done/`._
