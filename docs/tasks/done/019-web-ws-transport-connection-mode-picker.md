# 019 — web ws transport + connection-mode picker

- **Status:** done
- **Mode:** HITL
- **Estimate:** 1d
- **Depends on:** none
- **Blocks:** none

## Goal

Add a real WebSocket transport to the web build (browser ↔ `web/server.mjs`) and expose a user-facing picker in the settings dialog (`Auto` / `Fastest` / `Streaming` / `Basic`). When WS is active, frames + input + control ride one full-duplex socket; SSE + POST stay as fallbacks. `Auto` starts on the last-good cached mode (else WS), downgrades the chain on failure, and re-probes upward on tab focus.

## Why now

Web users report visibly slower input than Electron. The grilled root cause: input flushes pay per-RTT TLS/auth through the proxy chain. WS through portal.dustin.one (nginx + Authentik) was assumed unworkable per ADR-0006 — verification on 2026-05-28 proved otherwise once three `proxy_set_header` lines were added to the NPM custom config (see memory `ws-works-through-portal`). Unblocks parity with Electron's latency floor; the picker is the safety net for environments where WS still fails.

## Acceptance criteria

- [ ] `/api/ws` endpoint on `web/server.mjs` accepts upgrade and speaks the `CdpBridge` contract over a single socket (messages `{ t, id?, ... }` with `t ∈ {event, send, invoke, invoke-result, frame, ack}`).
- [ ] Browser opens WS via `cdp-web-transport.ts`; SSE + POST paths remain available as fallbacks.
- [ ] Settings dialog renders a 2×2 `ToggleGroup` with options **Auto / Fastest / Streaming / Basic**, each with a tooltip explaining the mechanism.
- [ ] Active mode badge shown next to the picker (e.g. "Active: Fastest").
- [ ] Setting persists in `localStorage` under `inputTransport` (web only; hidden when `window.webCaps` absent).
- [ ] Changing the setting tears down the active transport and reconnects within ~1s.
- [ ] Auto chain: try last-good (or WS if no cache) → on fail/no-ack within 3s, downgrade to Stream → on fail, Batch. Cache the working mode in `localStorage`.
- [ ] Auto re-probes upward on tab/PWA focus when degraded.
- [ ] Manual pick failure → status-bar banner "WS unavailable. Retry · Use Auto" (no silent fall-through).
- [ ] Mid-session drop: 3 bounded retries (1s/2s/4s backoff) on the same mode first; then Auto silently falls / Manual shows the banner.
- [ ] E2E mode (when `E2E_PASSPHRASE` set) wraps every WS message via the same `crypto-envelope.ts` seal as SSE+POST today.
- [ ] Throwaway `/api/ws-probe` endpoint removed.
- [ ] ADR-0007 written, references ADR-0006, records the proxy-config fix that made WS viable.

## Test plan

### Layer 1 — Pure logic (TDD)

- [ ] `transport-selector.ts` — covers Auto fall WS→Stream→Batch on each step's failure
- [ ] `transport-selector.ts` — covers mid-session drop → 3 retries → fall (Auto) / banner (Manual)
- [ ] `transport-selector.ts` — covers re-probe-on-focus upgrade path
- [ ] WS message envelope codec (`{ t, id?, ... }`) — round-trip for each `t`
- [ ] localStorage cache helper for last-good — read/write/missing

### Layer 2 — Manual smoke (CDP/IPC)

- [ ] Boot `web/server.mjs` locally, browser connects on WS, frames + clicks work end-to-end.
- [ ] Force-pick Stream, then Batch, then back to WS — each switch reconnects cleanly without lost tab state.
- [ ] Temporarily break WS at the proxy (revert nginx fix) — Auto downgrades silently; manual WS pick shows the banner.
- [ ] Idle ≥60s on WS — proxy keep-alive holds (already verified with probe).
- [ ] With `E2E_PASSPHRASE` set, WS payloads are sealed; tampered payload rejected by server.

### Layer 3 — Visual review

- [ ] Screenshots captured via Chrome MCP against `pnpm web` running locally.
- [ ] States visible for the picker: default (Auto), explicit pick, degraded badge, error banner.
- [ ] 2×2 grid legible at 380px sheet width (existing dialog width).

## Design notes

- **Contracts changed:** `CdpBridge` — no shape change; transports become interchangeable behind it. New internal type `InputTransportMode = "auto" | "ws" | "stream" | "batch"` (UI labels: `Fastest`→`ws`, `Basic`→`batch`).
- **New modules:** `src/lib/transport-selector.ts` — pure mode-selection state machine (probe / downgrade / retry / re-probe). Reuses `createSingleFlight` / `createHoverGate` for existing paths.
- **New ADR needed?** Yes — **ADR-0007: web build adds optional WebSocket transport**. References ADR-0006 (which stays unchanged per append-only rule); records the proxy-config prerequisite and the picker as safety net.

Message envelope:

```ts
type WsMessage =
  | { t: "event"; method: string; params: unknown }
  | { t: "send"; method: string; params: unknown }
  | { t: "invoke"; id: number; method: string; params: unknown }
  | { t: "invoke-result"; id: number; ok: true; result: unknown }
  | { t: "invoke-result"; id: number; ok: false; error: string }
  | { t: "frame"; data: string; metadata: ScreencastMeta }
  | { t: "ack"; sessionId: number }
```

Selection state machine, sketch:

```ts
type State =
  | { kind: "probing"; mode: "ws" | "stream" }
  | { kind: "active"; mode: InputTransportMode }
  | { kind: "degraded"; mode: "stream" | "batch"; from: "ws" | "stream" }
  | { kind: "blocked"; reason: "manual-fail" | "all-fail" }
```

## Out of scope

- Replacing SSE + POST entirely. They stay as fallbacks for WS-hostile environments.
- Refactoring `main.js` onto the shared core (tracked separately).
- WebTransport (HTTP/3) — noted in ADR-0006 addendum t011 as future work; not in this task.
- Per-environment auto-detect of the picker default (still `Auto` everywhere; user opts in if needed).

## Definition of Done

All must be true before status → done.

- [ ] Layer 1 tests written and green
- [ ] Layer 2 smoke checklist completed against live portal.dustin.one
- [ ] Layer 3 screenshots captured and committed
- [ ] `pnpm check` clean (Biome — lint + format)
- [ ] `pnpm typecheck` clean
- [ ] `pnpm test` green
- [ ] `pnpm web` boots cleanly and WS works end-to-end through portal
- [ ] CLAUDE.md updated (web-build paragraph mentions WS option + picker; `src/lib/CLAUDE.md` documents `transport-selector.ts`)
- [ ] ADR-0007 written
- [ ] `/api/ws-probe` removed
- [ ] No commented-out code, no `console.log` debris, no AI attribution
- [ ] Task closed: status → done, file moved to `docs/tasks/done/`, t019 in commit

## Notes

Grill resolved in this session — see Q1–Q18 decisions in chat. Key data points:
- ADR-0006 said "no WS on the browser hop"; that was true at the time. Proxy config fix unblocked it (see memory `ws-works-through-portal`).
- Probe results: 101 Switching Protocols + 65s idle + bidirectional frames all ✓.
- The throwaway `/api/ws-probe` in `web/server.mjs` must come out before close.

---

_When task status flips to `done`, move this file to `done/`._
