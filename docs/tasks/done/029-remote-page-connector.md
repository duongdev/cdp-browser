# 029 — extract backend-agnostic remote page connector adopt web first

- **Status:** done
- **Mode:** HITL
- **Estimate:** 1d
- **Depends on:** none
- **Blocks:** none

## Goal

Extract a backend-agnostic Remote Page **connector** that owns the whole connect/disconnect choreography in one tested deep module: activate the Active Tab, resolve its target, open the Remote Page WebSocket, run `Page.enable` + `Input.enable` + theme emulation, re-apply the cached Adaptive Viewport device-metrics override, start the Screencast, and tear down cleanly — plus the `activeWs` / `cachedMetrics` / `connectId` race-guard that today lives as module-level mutables read by scattered handlers. The connector takes its effects by injection: a `transport(WebSocket)` factory, the `/json` endpoint builders, and settings. After this ships, the web build (`server.mjs`) drives its Remote Page through the connector (priority surface), the connect ordering and the overlapping-switch race-guard are unit-testable against a fake transport, and the previously-implicit metric re-application on reconnect is an explicit, asserted contract. ADR-0001 (single Remote Page) and ADR-0002 (cached metrics re-applied before each `startScreencast`) are preserved unchanged.

## Why now

The Remote Page connect choreography is the single hottest seam in both backends and it is currently duplicated and un-testable: the ordering of activate → resolve → enable → metrics → screencast, and the guard that a slower in-flight connect can't clobber a newer one, exist only as side effects against module-level mutables that many handlers read and write. A backend-agnostic connector consolidates that into one deep module behind a thin interface, makes the tab-switch edge cases (overlapping switches, stale-socket arrival, reconnect metric re-apply) exercisable with a fake transport, and gives reconnect/retry a single home to grow into later. The web build is the priority surface (PWA-on-iPad), so it adopts first; once proven there, main.js follows. This is part of the shared-CJS-core extraction sanctioned by ADR-0008; it does not introduce the monorepo, only a backend-agnostic repo-root module both backends consume via dependency injection.

## Acceptance criteria

- [ ] A backend-agnostic connector module exists at the repo root (CJS), constructed via a factory that takes injected `transport` (WebSocket factory), endpoint builders, and a settings reader — no Electron, no `server.mjs`, no DOM imports.
- [ ] `connect({ tabId })` performs the choreography in this exact order: activate target → resolve target wsUrl → open transport → `Page.enable` + `Input.enable` → theme emulation → re-apply cached device-metrics override (if Adaptive Viewport state has one) → `Page.startScreencast`.
- [ ] The connector holds a single live Remote Page socket at a time (ADR-0001): a new `connect` while one is live tears the previous socket down before the new one becomes active.
- [ ] Overlapping connects are race-guarded by a monotonic `connectId`: when a slower in-flight connect resolves after a newer one started, its socket is closed and discarded — never promoted to the active Remote Page, never emitting frames.
- [ ] On reconnect, the most recent cached device-metrics override is re-applied **before** `startScreencast` (ADR-0002); clearing the override (Adaptive Viewport dormant) re-applies nothing.
- [ ] `disconnect()` tears down the active socket, cancels any in-flight connect, and leaves no listeners attached (clean teardown — no stale `onEvent`/`onClose` firing afterward).
- [ ] `server.mjs` drives its Remote Page through the connector; its prior hand-rolled connect/teardown mutables are deleted (no dead duplicate path left behind).
- [ ] Web tab switching works end-to-end with no stale-socket race and Adaptive Viewport metrics re-applied after reconnect (Layer 2).
- [ ] If the web and main connect paths diverge materially, web adoption ships and main adoption is split into a tracked follow-up task referenced in Notes; main.js connect code is left untouched in that case.
- [ ] CONTEXT.md and CLAUDE.md reflect the connector as the owner of the Remote Page connect/disconnect lifecycle.

## Test plan

Per [../conventions/tdd.md](../conventions/tdd.md). The connector is a repo-root CJS core → strict TDD (Layer 1). Backend wiring is CDP/WS glue → manual smoke (Layer 2). No renderer UI changes → Layer 3 is the existing web canvas, observed only.

### Layer 1 — Pure logic (TDD)

- [ ] connector factory — `connect` issues activate → resolve → open → `Page.enable` + `Input.enable` → theme → metrics → `startScreencast` in that recorded order against a fake transport.
- [ ] connector factory — a second `connect` while one is live closes the prior socket before promoting the new one (single Remote Page invariant).
- [ ] connector factory — overlapping connects: an older in-flight `connect` resolving after a newer `connect` started has its socket closed and is never promoted (`connectId` race-guard); only the newest socket emits frames.
- [ ] connector factory — reconnect re-applies the cached device-metrics override before `startScreencast`; a cleared/empty metrics state re-applies nothing (ADR-0002).
- [ ] connector factory — `disconnect()` closes the active socket, cancels an in-flight connect, and no `onEvent`/`onClose` fires after teardown (clean teardown, no stale listeners).
- [ ] connector factory — fake transport that errors during `open` surfaces the failure without leaving a half-attached socket as the active Remote Page.

### Layer 2 — Manual smoke (CDP/IPC)

Steps to manually verify with a live Remote Browser (run `pnpm web`, open against a reachable CDP Host):

- [ ] Connect to the Remote Browser; the first Active Tab renders Screencast Frames and accepts Input Forwarding.
- [ ] Switch Tabs rapidly back and forth several times; the canvas always settles on the Tab you landed on — no frozen/stale frames from a prior Tab (race-guard holds).
- [ ] With Adaptive Viewport enabled, switch Tabs and confirm the new Tab fills the canvas with no letterbox bars on first settle (cached metrics re-applied before `startScreencast` on reconnect).
- [ ] Toggle theme sync (or OS theme); confirm theme emulation is applied on the freshly connected Remote Page after a switch.
- [ ] Kill/restart the CDP Host mid-session; confirm a clean reconnect with no duplicate or orphaned socket (verify only one live screencast in CDP `/json`).
- [ ] If main.js adoption is in scope this session: repeat the rapid-switch + Adaptive Viewport checks in `pnpm dev` (Electron). Otherwise note the follow-up and skip.

### Layer 3 — Visual review

- [ ] n/a — no renderer UI or layout changes; the Screencast canvas, sidebar, and toolbar are unchanged. Observed indirectly via the Layer 2 web smoke (correct Tab settles, no letterbox under Adaptive Viewport).

## Design notes

The connector is a **deep module**: a small surface (`connect`, `disconnect`, observable Remote Page events) hiding the full connect choreography and the race-guard. It is backend-agnostic — all effects (`WebSocket`, `/json` activate/list URLs, settings) arrive by injection, so the same module satisfies both the web server lifecycle and the Electron main process. It preserves the single-Remote-Page seam (ADR-0001) and the cached-metrics-before-screencast seam (ADR-0002); it does not change the Viewport Transform or Input Forwarding contracts.

- **Contracts changed:** Remote Page connect lifecycle — old: scattered module-level `activeWs` / `cachedMetrics` / `connectId` mutables read and written by many handlers in each backend → new: one injected connector instance per backend owning that state behind `connect`/`disconnect`. The connector emits Remote Page events (CDP messages, close) to its host, which fans them out exactly as before.
- **New modules:** one repo-root CJS connector core (`createRemotePageConnector({ transport, endpoints, settings, now })`) — the single home for connect/disconnect choreography + `connectId` race-guard, consumed by both backends via DI. No new browser/renderer module.
- **New ADR needed?** no — covered by ADR-0001 (single Remote Page), ADR-0002 (Adaptive Viewport metric re-apply), and ADR-0008 (defer monorepo, extract shared CJS core). Append a one-line cross-reference if reviewers want it, but no new decision is being made.

```ts
// injected effects — the connector owns choreography, host owns fan-out
interface RemotePageConnectorDeps {
  transport: (wsUrl: string) => RemotePageSocket; // WebSocket-shaped
  endpoints: {
    activate: (id: string) => string; // /json/activate/{id}
    targets: () => string; // /json
  };
  settings: () => { theme: string /* + theme-emulation inputs */ };
  now: () => number;
}

interface RemotePageConnector {
  connect(args: { tabId: string }): Promise<void>; // race-guarded by connectId
  disconnect(): void; // cancels in-flight + tears down active socket
  isConnected(): boolean;
  // cached device-metrics override (Adaptive Viewport) re-applied before startScreencast
  setMetricsOverride(override: DeviceMetricsOverride | null): void;
  onEvent(cb: (msg: unknown) => void): () => void;
  onClose(cb: () => void): () => void;
}
```

## Out of scope

- Adding reconnect/retry/backoff behavior — the connector centralizes the seam so it *can* grow that later, but this task only relocates today's behavior, byte-for-byte equivalent.
- The Downlink/Uplink web transport split (separate task) — the connector consumes an injected `transport` factory and is agnostic to which transport adapter provides the socket.
- Tab-lifecycle planning (close/switch MRU dance) — that is a separate pure tab-lifecycle module; the connector only acts on the resolved Active Tab it is told to connect.
- Notification Side-Channel sockets — the connector governs the single Remote Page (screencast/input) socket only; auxiliary read-only side-channel sockets are untouched (ADR-0003).
- main.js adoption **if** the connect paths diverge materially — in that case web ships and main.js adoption becomes a tracked follow-up; main.js stays CJS either way.
- Settings/endpoint adoption into main.js (the `createSettingsStore` + endpoint-builder swap) — that is a separate, lower-priority Electron-only cleanup task.

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

- Priority surface is web (`server.mjs`) — adopt there first, prove the race-guard + metric re-apply under real iPad/PWA tab-switching before touching main.js.
- Watch for a material divergence between web and main connect paths (e.g. theme-emulation timing, how each resolves a target wsUrl, Electron's session/permission steps). If found, ship web adoption and open a follow-up task for main.js adoption; record the task ID here and leave main.js connect code untouched this session.
- The `connectId` race-guard is the load-bearing invariant: the bug class it kills is a slow connect from a just-abandoned Tab promoting its socket and emitting frames over the Tab the user actually landed on.
- Keep the connector free of any per-app/notification knowledge — it is purely the Remote Page screencast/input lifecycle.
- The cached device-metrics override is set by the Adaptive Viewport state machine and re-applied here on every (re)connect before `startScreencast` (ADR-0002); a `null` override means re-apply nothing.

---

_When task status flips to `done`, move this file to `done/`._
