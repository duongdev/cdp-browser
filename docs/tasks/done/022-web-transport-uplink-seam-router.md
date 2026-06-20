# 022 — extract uplink seam and ready-transport router

- **Status:** done
- **Mode:** HITL
- **Estimate:** 1d
- **Depends on:** 021
- **Blocks:** 023

## Goal

The web build's client→server command path is split into an explicit **Uplink** seam — `{ isReady, send, sendBatch, invoke, close }` — with three interchangeable adapters (WS, streaming, POST) and a single **uplink-router** that chooses the ready adapter in exactly one place. Today the choice of where a command goes (`wsReady ? ws.batch : streamReady ? stream : cdp-batch POST`) is inlined and duplicated across both branches of the input batcher and again in the bare `send`/`invoke` paths, so adding or reordering a transport means editing every call site. After this task every command flows `caller → router.pick() → uplink.<method>()`; `send`, `sendBatch`, and `invoke` stop knowing which transport exists. `transport-selector.ts` stays pure and advisory — it computes *want-ws / downgrade / re-probe* intent; the router consumes that advice and owns adapter instantiation, readiness, and teardown. The change is behavior-preserving: input latency and the Auto/WS/Stream/Basic picker behave exactly as before.

## Why now

This is the second structural step of the #3 web-transport split (the Downlink seam lands in 021; this is the Uplink half). Consolidating the routing decision is the precondition for 023, which folds the E2E seal into one place and thins out `cdp-web-transport.ts` — neither is safe while the seal and the transport choice are scattered across the batcher branches and the raw send paths. It also makes a future transport (e.g. WebTransport) a single new adapter + one selector entry rather than another inlined ternary in every call site. Web/PWA-on-iPad is the priority surface, and its input latency is governed entirely by this path.

## Acceptance criteria

- [ ] An `Uplink` interface `{ isReady(): boolean; send(cmd): void; sendBatch(cmds): void; invoke(method, params): Promise<unknown>; close(): void }` exists, with three adapters implementing it: `ws`, `stream`, `batch` (POST `/api/cdp-batch`).
- [ ] The WS adapter is the one adapter that backs **both** the Downlink event source (from 021) and this Uplink — a single socket, two seams, not two sockets.
- [ ] An `uplink-router` owns the set of adapters and exposes the same `{ isReady, send, sendBatch, invoke, close }` surface; it delegates to the ready adapter chosen from `transport-selector.ts`'s advised mode.
- [ ] Routing decisions live only inside the router. The input batcher and the raw `send`/`invoke` paths call the router's methods and contain no `wsReady ? … : …` transport ternary.
- [ ] `transport-selector.ts` is unchanged in contract and remains pure (no socket/fetch/DOM); it advises mode, the router instantiates and tears down.
- [ ] When the advised mode's adapter is not `isReady()`, the router falls to the next ready adapter in the WS→stream→batch order without dropping the command (matches today's fallback behavior).
- [ ] Mode-picker changes (Auto / Fastest / Streaming / Basic) re-point the router at the corresponding adapter and reconnect within ~1s, same as before.
- [ ] The existing 020 transport tests stay green with no edits (behavior-preserving proof).
- [ ] `cdp-web-transport.ts` wires the router into `window.cdp`'s `send`/`sendBatch`/`invoke`; the public `CdpBridge` contract is unchanged.
- [ ] Input coalescing (`input-coalesce.ts` — hover gate, single-flight, move-collapse) is preserved and feeds the router; the batcher no longer picks a transport itself.

## Test plan

### Layer 1 — Pure logic (TDD)

- [ ] `uplink-router` — `pick()` returns the advised mode's adapter when it `isReady()`; covers WS-ready, stream-ready, batch-ready.
- [ ] `uplink-router` — advised adapter not ready → falls to next ready adapter in WS→stream→batch order; command is delegated, never dropped.
- [ ] `uplink-router` — `send` / `sendBatch` / `invoke` each delegate to the picked adapter's matching method (verified with fake adapters).
- [ ] `uplink-router` — `close()` closes every owned adapter exactly once.
- [ ] `uplink-router` — re-point on mode change tears down the prior active adapter and routes to the new one.
- [ ] Fake `Uplink` adapters (WS / stream / batch) exercised through the router with no real socket/fetch — `isReady` toggling drives the fall-through.

### Layer 2 — Manual smoke (CDP/IPC)

Steps to manually verify with a live Remote Browser via `pnpm web` (through the deployment to match the real proxy chain):

- [ ] Boot `web/server.mjs`, connect on Auto — clicks, scroll, and typing forward end-to-end with no perceptible latency change vs `main` before this task.
- [ ] Force-pick **Fastest (WS)** — input rides the WS uplink; mouse/keyboard work; no duplicate sockets in the network panel.
- [ ] Force-pick **Streaming** — input rides `/api/input-stream`; works; switching back to WS reconnects cleanly.
- [ ] Force-pick **Basic** — input rides `/api/cdp-batch` POST with move-collapse intact; clicks still beat buffered moves.
- [ ] Break WS at the proxy (revert the nginx fix) — Auto downgrades through the router silently; clicks keep working on the fallen-to adapter.
- [ ] With `E2E_PASSPHRASE` set, sealed payloads still flow on every adapter (seal still applied where it is today; not yet moved — that is 023).

### Layer 3 — Visual review

- [ ] Screenshots captured via Chrome MCP against `pnpm web` running locally.
- [ ] Connection-mode picker states visible: Auto (default), explicit pick, degraded/active badge — unchanged from 019.
- [ ] No UI regression: the picker, active-mode badge, and "WS unavailable" banner render and behave as before (this task is plumbing behind the picker, not new UI).

## Design notes

This task draws a seam between *deciding which transport carries a command* (the router) and *carrying it* (the adapters), giving the routing decision a single home and high locality. The WS adapter has high leverage: one socket serves both the Downlink (server→client events + Screencast Frames) and the Uplink (client→server Input Forwarding + control). `transport-selector.ts` stays a shallow, pure advisor — it never touches a socket — so the deep, effectful router can be swapped or extended without disturbing the tested state machine.

- **Contracts changed:** `CdpBridge` — no shape change; `send` / `sendBatch` / `invoke` are re-backed by the router instead of inlined ternaries. New internal `Uplink` interface introduced; `transport-selector.ts`'s `InputTransportMode` and its public functions are unchanged.
- **New modules:** `src/lib/uplink-router.ts` — pure-ish router that, given the set of adapters and the selector's advised mode, picks the ready uplink and delegates; one place for the WS→stream→batch fall-through. The three adapters are thin effect wrappers (WS / stream / POST) that live with the existing transport effects, not in `src/lib/` (they hold sockets/fetch).
- **New ADR needed?** No — this realizes the Uplink seam already sanctioned in the #3 split plan and ADR-0007; no new architectural decision. (If the seam shape materially diverges from ADR-0007's description, append an addendum there rather than a new ADR.)

```ts
// the seam every command crosses
interface Uplink {
  isReady(): boolean
  send(cmd: CdpCommand): void
  sendBatch(cmds: CdpCommand[]): void
  invoke(method: string, params?: unknown): Promise<unknown>
  close(): void
}

// the router: same surface, owns the choice in one place
interface UplinkRouter extends Uplink {
  // picks per advised mode (transport-selector), falls WS→stream→batch on not-ready
}

// pure advice in, effectful adapter out — selector never instantiates
type AdvisedMode = "ws" | "stream" | "batch" // derived from InputTransportMode
```

Data flow after the change: `input-coalesce` (hover gate / single-flight / move-collapse) → `uplink-router.sendBatch()` → `router.pick(advisedMode)` → `wsUplink | streamUplink | batchUplink`. The E2E seal stays exactly where it is today; relocating it to a single choke point is 023's job, not this one.

## Out of scope

- Folding the E2E seal into one place and the broader thin-out of `cdp-web-transport.ts` — that is 023.
- The Downlink seam (event source / dispatcher) — landed in 021; this task consumes the WS adapter it shares but does not re-touch downlink wiring.
- Cutting the default-OFF frame tunnel — handled in the #3 plan's other slice, not here.
- Any change to `transport-selector.ts`'s behavior, the picker UI, or the persisted `inputTransport` setting.
- Refactoring `main.js` onto the shared core (separate, lower-priority task).
- New transports (WebTransport / HTTP-3) — the router makes them cheap to add later but none is added now.

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

- Hard constraint: the 020 transport tests must pass untouched — they are the behavior-preserving oracle for this refactor. If a 020 test needs editing, the change is not behavior-preserving and the seam shape is wrong.
- The WS adapter is shared with the Downlink seam from 021: one socket, two seams. Verify in the network panel that no second WS connection appears after this lands.
- Smoke must run through the real proxy chain (the deployment) — latency parity is the whole point and only shows up under real RTT.
- Keep `transport-selector.ts` honest: if the router starts needing to *ask* the selector about readiness, the seam has leaked — readiness belongs to the adapters, mode advice belongs to the selector.

---

_When task status flips to `done`, move this file to `done/`._
