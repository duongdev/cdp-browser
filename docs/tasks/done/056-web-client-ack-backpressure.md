# 056 — client ack-after-paint backpressure on web path (one frame in flight)

- **Status:** done
- **Mode:** HITL
- **Ring:** inner
- **Slice:** 4-table-stakes-latency
- **Estimate:** 1d
- **Depends on:** 054
- **Blocks:** none

## Goal

On the web path the proxy server acks every Screencast Frame itself (`remotePage.ackFrame` fires the moment a frame leaves the active socket, before any client has painted it), so the remote browser is free to push the next frame regardless of how fast the client can decode and draw. A slow link or a busy iPad then accumulates **more than one frame in flight** — the remote keeps producing, the queue between remote and client grows, and what the user sees drifts further behind reality the harder the page works. The Electron path already avoids this: the renderer acks each frame only after it has handled it (`Page.screencastFrameAck` is sent from inside `createRemotePage`), so at most one frame is ever outstanding. After this task the web client mirrors that — it acks **after paint**, and the server **defers its self-ack** on the screencast path for any client that announces ack-after-paint support — so on a slow link there is at most one Screencast Frame in flight instead of an unbounded backlog.

## Why now

This is a v0.1.0 inner-ring "never-stuck / table-stakes latency" item: the daily-driver surface is the web PWA on an iPad over a real link, exactly where the unbounded backlog bites. It is one of the cheap, codec-free latency wins the locked scope green-lit for v0.1.0 (the WebRTC/WebCodecs path is deferred to a data-driven v0.2 call). It builds directly on t054 (cap `everyNthFrame` + server frame-rate throttle) — t054 limits how fast the remote produces, this caps how many produced frames can be outstanding before the client catches up. Together they stop stale-frame pile-up from both ends. The latency-tier picker (t055) and the always-on metrics + HUD (t057) sit alongside; this task is the backpressure leg of the same slice.

## Acceptance criteria

- [ ] The web client acks each Screencast Frame **after** it has painted it (or decisively skipped it), not on receipt — mirroring the Electron renderer's ack-after-handle behavior.
- [ ] At most **one** Screencast Frame is in flight on the web path: while a frame is awaiting its client ack, the server does not request the next frame for that client. A pure predicate decides "may request next frame" from the one-in-flight rule and is unit-tested.
- [ ] The server **defers** its own self-ack on the screencast path when the connected client announced ack-after-paint support, and the client's `Page.screencastFrameAck` is honored instead of being dropped (today `web/server.mjs` explicitly ignores client `Page.screencastFrameAck` retries because it self-acks).
- [ ] A client that does **not** announce support falls back to the current server-self-ack behavior unchanged — no regression for older clients or the SSE-only path where appropriate.
- [ ] Under a slow client + fast remote, the in-flight queue stays capped at one frame and end-to-end frame age does **not** grow unbounded over time (it converges to one-frame latency, not a widening backlog).
- [ ] WS and SSE downlinks both honor the cap; switching transports does not leave a frame un-acked and wedge the stream.
- [ ] A dropped/closed connection does not strand a pending ack such that the next connect stalls (the in-flight state resets on Downlink close).
- [ ] `pnpm test` / `pnpm typecheck` / `pnpm check` (touched files) green.

## Test plan

Which testing layers apply (see [../conventions/tdd.md](../conventions/tdd.md)) and what specifically is tested.

### Layer 1 — Pure logic (TDD)

- [ ] ack-gate predicate — "may request/forward next frame" is `true` only when no frame is outstanding for the client; pushing a frame marks it outstanding, the client ack clears it.
- [ ] ack-gate — a second frame arriving while one is outstanding is held (or coalesced to the latest, per the chosen policy) and not double-counted; the ack releases exactly one slot.
- [ ] ack-gate — `reset()` (Downlink close / reconnect) clears outstanding state so the next frame is immediately eligible.
- [ ] ack-gate — out-of-order or duplicate acks for an already-cleared frame are no-ops (do not push the count negative or free a slot twice).

### Layer 2 — Manual smoke (CDP/IPC)

Steps to manually verify with a live Remote Browser (run `pnpm web` against the CDP host). Server + transport change → **HITL**, needs a live remote.

- [ ] Boot `web/server.mjs`, open the web build with WS reachable — the Screencast renders live and acks now ride the client.
- [ ] Throttle the client (DevTools CPU/network throttle, or a heavy remote page) and watch a frame-age / FPS readout: the visible frame stays at most one frame behind, frame age does not climb without bound, and the stream recovers immediately when throttling is removed (no multi-second catch-up replay).
- [ ] Force the SSE-only downlink (no WS) and repeat — the cap still holds.
- [ ] Drop the connection mid-stream and reconnect — the stream resumes (no wedged stream from a stranded ack).
- [ ] Confirm a client that does not announce support (or the old behavior path) still streams via server self-ack with no change.

### Layer 3 — Visual review

n/a — no new UI surface. The frame-age / FPS readout used for Layer 2 is the existing debug instrumentation (`perf-mark.ts`, `?perf=1`), not a shipped visual. iPad-physical confirmation of the slow-link behavior is folded into the t018 acceptance gate (HITL).

## Design notes

Describe the behavioral change, not the implementation path. Reference types, interfaces, and module contracts — not file paths or line numbers.

- **Contracts changed:** the web Downlink/screencast contract gains a client→server **ack-after-paint** capability. The client announces support (a flag on the WS handshake / a probe, alongside the existing `stream-ack` probe), and the server's per-frame fan-out switches from unconditional `remotePage.ackFrame(sessionId)` to **client-driven** ack for that client: the server forwards the frame, marks it outstanding, and only requests/forwards the next frame after the client's `Page.screencastFrameAck` arrives. Today `web/server.mjs` self-acks in the `onEvent` fan-out and then drops the client's `Page.screencastFrameAck` as a redundant retry — this task inverts that for supporting clients.
- **Contracts changed:** the browser Downlink dispatcher (`downlink-dispatcher.ts`) currently auto-acks on receive (mirroring `remote-page.ts`'s inline ack). On the web path the ack must move to **after the frame listener paints** — i.e. `viewport.tsx`'s `onFrame` callback signals "painted" and the ack fires then. Keep the Electron path's existing ack semantics intact; the web path is the one that moves the ack downstream of paint.
- **New modules:** none required, but a small **pure ack-gate** helper (one-in-flight predicate: `markSent` / `ackReceived` / `mayProceed` / `reset`) is the Layer-1-testable core. It can live in `input-coalesce.ts`-adjacent territory or a new tiny pure module under `src/lib/` (and/or its server twin) — choose the seam that keeps the predicate pure and shared, per the pure-module invariant (effects stay in `viewport.tsx` / `server.mjs`).
- **New ADR needed?** No — refines the screencast frame-ack policy within the web-transport ADRs (ADR-0006 SSE+POST, ADR-0007 WS). The single-Remote-Page and server-self-ack rationale (frame ack must not pay a per-frame HTTP round-trip — see t006) still holds for the non-supporting path; this adds a client-acked path on top for clients that can carry it cheaply (the WS / streaming channel makes the ack near-free vs. the original per-frame POST that t006 was avoiding).

Sketch of the pure ack-gate the predicate tests bind to:

```ts
// pure, one-frame-in-flight — server-side and/or client-side
interface AckGate {
  mayProceed(): boolean        // true only when nothing is outstanding
  markSent(sessionId: number): void   // a frame went to the client
  ackReceived(sessionId: number): void // client painted + acked it
  reset(): void                // Downlink close / reconnect
}
```

Wiring (web path, supporting client):

```
remote frame → server: mark outstanding → forward to client (no self-ack)
client: decode → paint → signal "painted" → send Page.screencastFrameAck
server: ackReceived → ack the remote (ride the connector socket) → eligible for next frame
```

## Out of scope

What this task explicitly does NOT do. Capture related work as separate tasks.

- The codec swap (WebRTC / WebCodecs) — deferred to a data-driven v0.2 call.
- The latency-tier picker (Sharp/Balanced/Snappy) — that is t055.
- The always-on RTT/jitter + frame-age metrics estimator and the toggleable latency HUD — those are t057 (inner) and t059 (outer); this task only consumes the existing `perf-mark.ts` frame-age debug readout for verification.
- The `everyNthFrame` cap + server frame-rate throttle — that is the t054 dependency; this task assumes it and adds the in-flight cap on top.
- Changing the Electron renderer's ack semantics (it already acks after handling; left untouched).
- Any change to the input uplink backpressure (`input-coalesce.ts` single-flight / hover gate) — input is a separate channel from frame ack.

## Definition of Done

All must be true before status → done.

- [ ] Layer 1 tests written and green (the pure ack-gate predicate)
- [ ] Layer 2 smoke checklist completed with a live Remote Browser (server + transport change → HITL)
- [ ] Layer 3 — n/a (no UI surface), noted above
- [ ] `pnpm check` clean (Biome — lint + format, touched files)
- [ ] `pnpm typecheck` clean
- [ ] `pnpm test` green
- [ ] `pnpm web` boots cleanly and the Screencast streams with the cap holding under throttle
- [ ] CLAUDE.md / `src/lib/CLAUDE.md` updated for the changed frame-ack policy (the "server self-acks" line and the `Page.screencastFrameAck` invariant note both need the new client-acked path)
- [ ] ADR not required (refines within ADR-0006 / ADR-0007); if the policy split warrants a record, draft it
- [ ] No commented-out code, no `console.log` debris, no AI attribution
- [ ] Task closed: status → done, file moved to `docs/tasks/done/`, t056 in commit

## Notes

- The reason the web path self-acks at all (t006) was to avoid a per-frame HTTP POST round-trip throttling the stream. That cost is gone on the WS / streaming downlink — a client ack is a cheap frame on an already-open socket — so the original tradeoff that justified self-acking no longer applies for supporting clients. Keep the self-ack fallback for the plain SSE+POST client where the round-trip cost is real.
- Coalesce-vs-hold policy for a frame that arrives while one is outstanding: prefer **coalesce to the latest** (drop the intermediate, like the input hover-gate's "jump to latest" feel) over queueing, so the user always sees the freshest available frame rather than replaying a stale one. Pin the chosen policy in the Layer-1 tests.
- The hard regression risk is a **stranded ack wedging the stream**: if a frame is forwarded, marked outstanding, and the client never acks (decode error, tab hidden, connection drop), the stream must not freeze forever. `reset()` on Downlink close covers reconnect; consider a watchdog timeout that frees the slot if no ack lands within a bound, so a single dropped paint can't permanently stall the stream. Decide and test this during work.
