# 023 — fold e2e into seams and thin the web cdp shim

- **Status:** done
- **Mode:** HITL
- **Estimate:** 1d
- **Depends on:** 022
- **Blocks:** none

## Goal

After this ships, the web build's E2E seal lives in exactly two places — the uplink-router seals every client→server body once before it leaves, and the downlink dispatcher opens every server→client envelope once on the way in — instead of being smeared across the per-call `getJson`/`postJson`/`postRaw`/`rawSend`/`onSse` helpers in the web `window.cdp` closure. With the Downlink and Uplink seams (from 022) carrying transport and crypto, `createWebCdp` collapses from a ~963-line closure into a thin assembler: it wires the two seams together and exposes the REST bridge (tabs, config, ui-state, pins, notifications, theme) on top, satisfying the same `CdpBridge` contract the renderer already consumes. The change is behavior-preserving — the 020 transport tests stay green and the wire format on both transports is byte-identical to today.

## Why now

This is the last step of the #3 web-transport seam (ADR-0007). 022 split the transport into the Downlink (server→client event source, WS-or-SSE, one live, feeding a single dispatcher that decodes/filters/fans-out/toasts once) and Uplink (client→server, WS-or-stream-or-POST) interfaces and introduced the uplink-router. This task finishes the job by moving the one remaining cross-cut — the E2E envelope — into those seams so the 963-line closure becomes a small wiring layer with all transport concerns behind two interfaces. Once the seal lives in one place per direction, the daily-driver web transport (the priority surface, PWA-on-iPad) is fully deepened: adding or reordering transports never re-touches crypto, and the shim has nowhere left to hide a divergence. No downstream task waits on it; it closes the transport deepening track.

## Acceptance criteria

- [ ] The E2E seal is applied in exactly one place on the uplink path (the uplink-router) and the E2E open in exactly one place on the downlink path (the dispatcher); no `seal`/`open` calls remain in the per-call REST/invoke/send helpers.
- [ ] `createWebCdp` no longer contains `getJson`/`postJson`/`postRaw`/`rawSend`/`onSse` scatter; transport reads and writes go through the Downlink and Uplink seams from 022.
- [ ] `createWebCdp` is a thin assembler: it constructs the Downlink + Uplink, wires the dispatcher, and exposes the REST bridge (tabs/config/ui-state/pins/notifications/theme) plus the `CdpBridge` surface — no transport-selection or crypto branching inline.
- [ ] The passphrase handshake (verifier round-trip against `GET /api/crypto-params`) gates the seams: an uplink refuses to send and the downlink refuses to dispatch until the handshake confirms; a wrong passphrase is rejected as before.
- [ ] With E2E ON (`E2E_PASSPHRASE` set on the server), `/api` bodies and downlink frames/events/input are sealed in AES-256-GCM and round-trip correctly over both WS and SSE+POST.
- [ ] With E2E OFF, every body and frame is plaintext and the wire is byte-identical to the pre-022 baseline.
- [ ] `transport-selector.ts` stays pure and advisory — it is not given the seal and does not gain transport handles.
- [ ] The 020 transport tests stay green unchanged (behavior-preserving).
- [ ] The default-OFF frame tunnel stays cut (removed in 022); this task does not reintroduce it.

## Test plan

Per [../conventions/tdd.md](../conventions/tdd.md). The seal-placement logic is pure (Layer 1); the live round-trip over a Remote Browser is manual smoke (Layer 2); there is no new UI surface (Layer 3 covers only the unchanged connection-mode picker / E2E passphrase entry).

### Layer 1 — Pure logic (TDD)

- [ ] uplink-router seal placement — given an E2E-on context, the body handed to the chosen uplink is sealed exactly once; given E2E-off, the body passes through unsealed.
- [ ] uplink-router single-seam routing — when both WS and stream/POST uplinks are present, the seal is applied once regardless of which uplink is ready (the seal precedes the transport pick, not per-transport).
- [ ] dispatcher open placement — an E2E-sealed downlink message is opened once before decode/filter/fan-out/toast; an unsealed message in E2E-off mode is decoded directly.
- [ ] dispatcher handshake gate — dispatch is refused until the verifier handshake confirms; a message arriving before confirmation is not fanned out.
- [ ] uplink handshake gate — `send`/`sendBatch`/`invoke` refuse (or queue per the 022 contract) until the handshake confirms.
- [ ] `crypto-envelope.ts` browser seal/open round-trips a representative invoke body, a batch, and an input frame (PBKDF2 key from passphrase + salt) — reused, not re-tested, if 012 already covers it; add only gaps exposed by the new call sites.

### Layer 2 — Manual smoke (CDP/IPC)

Run `pnpm web` against a live Remote Browser, once with `E2E_PASSPHRASE` set and once unset.

- [ ] E2E ON: open the PWA, enter the correct passphrase → handshake confirms, the Active Tab's Screencast Frames render and Input Forwarding (click + type) round-trips. Inspect `/api` traffic: bodies and frames are opaque (sealed), not readable JSON.
- [ ] E2E ON, wrong passphrase: the verifier handshake rejects and the client surfaces the failure (no frames, no silent half-connected state).
- [ ] E2E ON over WS: force Fastest (WS) mode → frames + events + input all ride the socket and remain sealed; switch a Tab and confirm reconnect still seals.
- [ ] E2E ON over SSE+POST: force Streaming/Basic mode → same sealed round-trip via `GET /api/events` + POST.
- [ ] E2E OFF: open the PWA (no passphrase prompt) → frames render, Input Forwarding works, `/api` bodies are plaintext JSON identical to the pre-022 baseline.
- [ ] REST bridge in both modes: a config save, a pin write, and a notifications read each succeed (sealed when ON, plaintext when OFF).

### Layer 3 — Visual review

- [ ] Screenshots captured via Chrome MCP against `pnpm web` (web build; `pnpm dev` is Electron and has no web transport).
- [ ] Four states on the connection surface: loading (handshake in flight / connecting), empty (no Tabs yet), error (wrong passphrase or unreachable proxy), populated (Active Tab streaming).
- [ ] The E2E passphrase entry and the Auto/WS/Stream/Basic connection-mode picker are unchanged (no visual regression — this task does not touch settings UI).

## Design notes

Behavioral contracts only; the seal moves from many call sites to two seam boundaries. Direction of the seal is fixed: seal-on-uplink-egress, open-on-downlink-ingress.

- **Contracts changed:**
  - `Uplink` (from 022) — its `send`/`sendBatch`/`invoke` now accept already-or-not-sealed payloads decided by the router, not by the caller. The uplink itself stays crypto-agnostic; the router owns the seal.
  - `Downlink` (from 022) — its `onEvent` continues to deliver raw transport messages; the dispatcher (its single consumer) now owns the open step before decode/filter/fan-out/toast. Old: each `onSse`/handler decoded its own payload. New: one open, one decode, one fan-out.
  - `createWebCdp` — old: a ~963-line closure holding transport reads/writes (`getJson`/`postJson`/`postRaw`/`rawSend`/`onSse`), selection, and crypto inline. New: a thin assembler wiring Downlink + Uplink + dispatcher and exposing the REST bridge + `CdpBridge` surface. The external `CdpBridge` contract the renderer consumes is unchanged.
  - `transport-selector.ts` — unchanged contract; remains pure/advisory and is never handed the seal or a transport handle.

- **New modules:** none — this folds responsibilities into the Downlink/Uplink seams and the uplink-router introduced by 022; it does not add a module.

- **New ADR needed?** no — ADR-0007 (web WebSocket transport) and ADR-0006 (web proxy SSE transport) already sanction the two-seam transport and the E2E envelope; this is a behavior-preserving consolidation within those decisions. CLAUDE.md's web-build paragraph is sharpened in this task's commit to state the seal lives in the uplink-router and the open in the dispatcher.

```ts
// E2E lives at the seam boundary, not per call.
// Uplink egress (one place):
type UplinkRouter = {
  // seals when the E2E context is active, then hands to the ready uplink
  send(msg: WireMessage): void
  sendBatch(msgs: WireMessage[]): void
  invoke(method: string, params: unknown): Promise<unknown>
}

// Downlink ingress (one place): the dispatcher is Downlink.onEvent's sole consumer
type Dispatcher = (raw: TransportMessage) => void
// raw -> open (if E2E) -> decode -> filter -> fan-out (events/frames) -> toast (once)

// Handshake gate (shared precondition): both seams refuse until confirmed.
type CryptoContext =
  | { mode: 'off' }
  | { mode: 'e2e'; ready: boolean; seal(b: Uint8Array): Uint8Array; open(b: Uint8Array): Uint8Array }
```

## Out of scope

- The 022 split itself (Downlink/Uplink interfaces, uplink-router introduction, frame-tunnel removal) — this task depends on it being done.
- Any change to the proxy↔CDP hop, the streaming input channel's NDJSON reassembly (`line-splitter.js`), or the hover-gate/single-flight backpressure logic.
- Any change to `transport-selector.ts` behavior, the connection-mode picker UI, or the E2E passphrase entry UI.
- Changing the wire format, the AES-256-GCM scheme, PBKDF2 parameters, or the `GET /api/crypto-params` salt endpoint.
- The Electron `main.js` transport — this is web-build only.
- Reintroducing the default-OFF frame tunnel.

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

- "Behavior-preserving" is the safety net: keep the 020 transport tests untouched and green throughout; if a test needs editing to pass, the change is not behavior-preserving and the diff is wrong.
- The seal ordering chain is the load-bearing invariant: seal-then-transport on egress, transport-then-open on ingress. Any place that seals after picking a transport, or opens after fan-out, reintroduces the scatter this task removes.
- `pnpm dev` in the DoD checklist is the Electron boot smoke; the web transport itself is exercised via `pnpm web` in Layer 2 — run both.

---

_When task status flips to `done`, move this file to `done/`._
