# 032 — adopt remote page connector in main.js (electron)

- **Status:** ready
- **Mode:** HITL
- **Estimate:** 1d
- **Depends on:** none
- **Blocks:** none

## Goal

`web/server.mjs` now drives its Remote Page connect/disconnect choreography through the backend-agnostic `remote-page-connector.js` (t029), but `main.js` still hand-rolls its own choreography in module-level mutables (`activeWs`, `activeTabId`, `connectId` race-guard, `cachedMetrics`). This task adopts the same connector in the Electron main process so the connect ordering, the overlapping-switch race-guard, and the metrics re-apply-on-reconnect live in one tested place for both backends — removing the last copy of that choreography.

## Why now

t029 deliberately shipped web-first and flagged main.js as a follow-up because the two connect paths diverge in ways the connector doesn't yet parameterize. Until this lands, a connect-ordering or race-guard fix must be made twice (the exact drift the shared-core effort exists to kill), and the connector's behavior in Electron is unverified.

## Acceptance criteria

- [ ] `main.js` builds a `createRemotePageConnector({ … })` instance and routes `cdp:connect` / `cdp:send` / `cdp:invoke` / disconnect through it; the hand-rolled `activeWs` / `connectId` / `cachedMetrics` mutables and the inline connect/teardown are deleted.
- [ ] Screencast `Page.startScreencast` sizing is parameterized via injected deps so main can pass its live-window-bounds sizing (`mainWindow.getBounds() * 2`) while web keeps its fixed cap — the connector no longer hardcodes the web values.
- [ ] Frame-ack ownership is preserved: main keeps acking frames where it does today (renderer-side vs server-side per the current design) — the connector's `onEvent` contract supports both raw and parsed delivery.
- [ ] `activeTabId` tracking that main relies on for notification OS-toast gating still works after adoption.
- [ ] Single live Remote Page (ADR-0001) and adaptive metrics re-apply on reconnect (ADR-0002) are preserved exactly.
- [ ] `pnpm test` green; `remote-page-connector.test.ts` extended for any newly injected dep.

## Test plan

Per [../conventions/tdd.md](../conventions/tdd.md).

### Layer 1 — Pure logic (TDD)
- [ ] Extend `remote-page-connector.test.ts` for the parameterized screencast-sizing dep (main vs web sizing) with a fake transport.
- [ ] Race-guard + metrics re-apply already covered — assert they still hold with the main-flavored deps.

### Layer 2 — Manual smoke (CDP/IPC)
- [ ] Rapid tab-switching in the Electron app against a live Remote Browser — no stale-socket race, no frame from the prior tab after switch.
- [ ] Adaptive Viewport on → reconnect (tab switch) re-applies the cached device-metrics override before screencast.
- [ ] Theme sync still applies on connect; CDP-host restart recovers.

### Layer 3 — Visual review
- [ ] n/a — no renderer UI change (main-process glue only).

## Design notes

- **Contracts changed:** `createRemotePageConnector` deps gain a screencast-sizing input (e.g. `screencastSize(): { maxWidth; maxHeight }`) so the connector stops hardcoding web's `3000×2000` / `1400×900`; main injects window-bounds sizing, web injects its fixed cap. `onEvent` already delivers the raw ws message — main's handler parses it (it currently `chromeSend`s the parsed message and acks renderer-side), web's forwards binary/SSE.
- **Divergences to resolve** (from t029's notes): (1) screencast sizing source; (2) main uses fixed CDP command ids `1..6` vs the connector's incrementing `cmdId` — adopt the connector's; (3) ack ownership (renderer-side in Electron vs server-side in web); (4) `activeTabId` is tracked on connect in main.
- **New modules:** none — reuse `remote-page-connector.js`.
- **New ADR needed?** no — ADR-0001 / ADR-0002 preserved; this is the sanctioned t029 follow-up.

## Out of scope

- Any change to the web build's already-adopted connector path.
- Notification side-channel sockets (separate from the Remote Page socket; unaffected).

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

Surfaced as a deliberate follow-up from t029 (web-first connector adoption). The connector + its 16 unit tests already exist; this is the Electron-side wiring plus parameterizing the one place (screencast sizing) where the two backends genuinely differ.

---

_When task status flips to `done`, move this file to `done/`._
