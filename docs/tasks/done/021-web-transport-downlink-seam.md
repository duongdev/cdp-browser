# 021 — extract downlink seam and event dispatcher; cut frame tunnel

- **Status:** done
- **Mode:** HITL
- **Estimate:** 1d
- **Depends on:** 020
- **Blocks:** 022

## Goal

Split the web build's server→client half of the `CdpBridge` into a named **Downlink** seam (`{ onEvent, onClose, close }`) with exactly one live event source — WS or SSE, never both — feeding a single **dispatcher** that decodes (E2E open), filters, fans out to listeners, and fires the OS/web toast exactly once. Today that decode-filter-fan-out-toast logic is re-implemented four times (the SSE `cdp`-event listener, the WS `onEvent` path, the WS binary-frame path, and the direct-frame tunnel), so they drift. After this ships there is one dispatcher behind one Downlink, the Screencast Frame has a single source, and the default-OFF direct-frame tunnel (~85 lines) is deleted so the dispatcher carries no de-dup branch.

## Why now

This is the first structural step of the #3 web-transport seam split (ADR-0008 direction). It collapses the 4× event-fan-out duplication into one deep dispatcher behind a shallow Downlink seam, raising locality and leverage, and removes dead weight — the frame tunnel is off by default and measurably slower on WebKit/iPad, so it earns its removal. Completing the Downlink seam is the precondition for the Uplink seam (022), which needs a clean event-source boundary to pick a ready uplink against. Web/PWA-on-iPad is the priority surface, so the web transport gets refactored first.

## Acceptance criteria

- [ ] A `Downlink` seam exists with the contract `{ onEvent(listener): unsubscribe, onClose(listener): unsubscribe, close() }`; exactly one Downlink instance is live at a time (WS-backed or SSE-backed), and switching sources tears the previous one down fully.
- [ ] A single dispatcher consumes the Downlink: it E2E-opens each inbound message once, filters, fans out to all registered listeners, and fires the OS/web toast once per Notification — no path bypasses it.
- [ ] The SSE `cdp`-event listener, the WS `onEvent` path, and the WS binary-frame path all route through the one dispatcher (no per-path decode/filter/toast copies remain).
- [ ] Screencast Frame delivery has a single source through the dispatcher; the WS binary-frame and SSE frame paths both surface as the same dispatched frame event.
- [ ] The default-OFF direct-frame tunnel (~85 lines) is deleted from server and browser, and the dispatcher contains no frame de-dup / tunnel-vs-event branch.
- [ ] WS→SSE fallback still works: when WS is unreachable the Downlink is SSE-backed and the dispatcher behaves identically.
- [ ] All 020 tests stay green — the kept paths are behavior-preserving.
- [ ] A `/learn` entry records why the frame tunnel was removed (off-by-default, slower on WebKit/iPad, single-source simplification) so it is not re-added blindly.

## Test plan

Which testing layers apply (see [../conventions/tdd.md](../conventions/tdd.md)) and what specifically is tested.

### Layer 1 — Pure logic (TDD)

- [ ] dispatcher — decodes (E2E-open) an inbound message once, then fans out to all registered listeners
- [ ] dispatcher — fires the toast exactly once per Notification (no double-fire across listeners)
- [ ] dispatcher — a filtered/ignored message produces no listener calls and no toast
- [ ] dispatcher — Screencast Frame events from a WS-binary source and an SSE source dispatch identically (single frame source)
- [ ] Downlink — `onEvent` / `onClose` register and `unsubscribe` removes the listener; `close()` notifies `onClose` listeners and detaches the source
- [ ] Downlink — only one source is ever live; constructing/activating a new source closes the prior one

### Layer 2 — Manual smoke (CDP/IPC)

Steps to manually verify with a live Remote Browser (run `pnpm web` against the CDP host):

- [ ] Boot `web/server.mjs`, open the web build with WS reachable — the Screencast renders and the Active Tab is live.
- [ ] Trigger a Teams or Outlook Notification on the remote browser — exactly one toast fires (not duplicated) and the notification bell badge increments once.
- [ ] Break WS at the proxy (or force SSE) — the Downlink falls back to SSE, the Screencast still renders, and a Notification still fires exactly one toast.
- [ ] Confirm no frame-tunnel endpoint/path is reachable (the removed route 404s / the toggle is gone) and frames still flow via the dispatcher.
- [ ] Switch transport modes via the connection-mode picker — each switch rebuilds the single Downlink cleanly with no lost tab state.

### Layer 3 — Visual review

- [ ] Screenshots captured via Chrome MCP against `pnpm web` (desktop browser) and an iPad PWA session.
- [ ] All four states visible: loading (connecting), empty (no Active Tab), error (Downlink closed / connection lost banner), populated (Screencast live).
- [ ] Notification toast appears once on the populated state; no visual flicker or double-paint on the Screencast canvas after removing the tunnel.

## Design notes

Describe the behavioral change, not the implementation path. Reference types, interfaces, and module contracts — not file paths or line numbers.

- **Contracts changed:** `CdpBridge` — no public shape change; the server→client half is now satisfied by a `Downlink` seam internally. The previous four inline dispatch paths (SSE `cdp` listener, WS `onEvent`, WS binary-frame, frame tunnel) collapse into one dispatcher behind one Downlink.
- **Contracts changed:** the direct-frame tunnel contract (its server endpoint, its browser consumer, and the default-OFF toggle) is **removed**, not deprecated — fresh-not-patched. The Screencast Frame now has a single delivery contract through the dispatcher.
- **New modules:** a Downlink seam and a dispatcher. The Downlink is the shallow source-abstraction (`{ onEvent, onClose, close }`) so the dispatcher is source-agnostic and only one is ever live. The dispatcher is the deep module owning decode-once → filter → fan-out → toast-once. Pure fan-out/dedup logic stays pure (lib-style) so it is Layer-1 testable; the source wiring (WS/SSE attach, E2E key, OS/web toast effect) stays in the effectful layer per the pure-module invariant.
- **New ADR needed?** No — proceeds under the #3 seam direction recorded in ADR-0008; this task only realizes the Downlink half. The Uplink half and the uplink-router (single-place E2E seal) land in 022. `transport-selector.ts` stays pure and advisory and is not modified here.

Sketch of the seam + dispatcher wiring:

```ts
// One live source, shallow seam — backed by WS or SSE, never both.
interface Downlink {
  onEvent(listener: (msg: DownlinkMessage) => void): () => void
  onClose(listener: (reason: CloseReason) => void): () => void
  close(): void
}

// Inbound, before E2E-open. The dispatcher decodes once, then routes.
type DownlinkMessage =
  | { t: "event"; method: string; params: unknown } // includes Screencast Frame as the single frame source
  | { t: "invoke-result"; id: number; ok: boolean; result?: unknown; error?: string }
  | { t: "sealed"; payload: string } // E2E envelope, opened once by the dispatcher

// Deep module: decode-once → filter → fan-out → toast-once.
interface Dispatcher {
  attach(source: Downlink): void
  subscribe(listener: (method: string, params: unknown) => void): () => void
  // toast firing is an internal effect, gated to once-per-Notification
}
```

## Out of scope

What this task explicitly does NOT do. Capture related work as separate tasks.

- The **Uplink** seam (`{ isReady, send, sendBatch, invoke, close }`), the uplink-router, and the single-place E2E seal — those are 022.
- Any change to `transport-selector.ts` (stays pure/advisory).
- Refactoring `main.js` onto the shared core (separate, lower-priority task).
- Changing the proxy/nginx WS config or the connection-mode picker UI (already shipped in t019).
- Adding new event kinds, new Notification Adapters, or `groupKey`/`activate` seam work (#1b, separate tasks).
- WebTransport (HTTP/3) or any new transport.

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

- Behavior-preserving for kept paths is the hard constraint: the 020 tests are the regression net — run them red/green around the refactor.
- The frame tunnel removal is deliberate dead-weight reduction; the `/learn` entry is part of the deliverable, not optional, so a future contributor doesn't reintroduce it chasing latency without re-checking the WebKit/iPad cost.
- Smoke must cover both the WS-backed and SSE-backed Downlink so the single-source guarantee is proven under fallback, not just the happy path.
- `pnpm dev` is the Electron renderer; the load-bearing end-to-end check here is `pnpm web` (desktop + iPad PWA) since this is web-transport-only.

---

_When task status flips to `done`, move this file to `done/`._
