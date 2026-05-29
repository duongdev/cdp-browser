# 020 — lock web transport behavior with characterization tests

- **Status:** done
- **Mode:** AFK
- **Estimate:** 0.5d
- **Depends on:** none
- **Blocks:** 021

## Goal

Today the web `window.cdp` shim — the deep module behind the Transport seam in the browser build — has almost no test coverage (only `collapseMoves` is exercised). This task adds a characterization-test suite that pins the shim's *current* observable behavior before any restructure: SSE/WS event fan-out to the registered listeners, the `send()` Input Forwarding routing decisions (drag vs hover vs wheel vs press/release), `collapseMoves` run-collapsing, the batch-routing branch across WS / streaming / single-flight POST, the E2E seal/open round-trip on every `/api` body, and the theme push. Every test drives the shim through injected fakes for `fetch`, `EventSource`, and `WebSocket` — no network, no live Remote Browser. After this ships, the web transport's behavioral contract is locked, so the #3 seam extraction (021-023) can be proven behavior-preserving instead of hoped-to-be.

## Why now

The web/PWA path is the priority surface, and its transport is the daily-driver glue with the least test leverage in the codebase. The locked architecture plan splits this one ~963-line shallow-seam-but-deep-file module into Downlink/Uplink seams with a single dispatcher and a single E2E-seal site (task 021). Restructuring a transport that the iPad PWA leans on every minute, with no behavioral net, is exactly the unsafe move the conventions warn against. This characterization suite is that net: it captures behavior as-is (including quirks), so 021's refactor either keeps the tests green or surfaces a real regression. Nothing else here changes; this is pure leverage for the tasks that follow.

## Acceptance criteria

- [ ] A test module exercises the web shim's listener fan-out: a decoded `cdp`, `disconnected`, `notification`, and `notification-activate` push each reaches every callback registered via the matching `onEvent`/`onDisconnected`/`onNotification`/`onNotificationActivate`, in registration order, exactly once.
- [ ] `collapseMoves` is covered for: empty input, a single `mouseMoved`, a run of consecutive `mouseMoved` collapsing to the latest, and a run broken by a click / wheel / key (order and breaks preserved).
- [ ] The `send()` Input Forwarding routing is asserted against fakes: hover (buttons-up `mouseMoved`) is held by the hover gate on the POST-fallback path; drag (button held `mouseMoved`) tracks live (coalesced, gate cancelled); `mouseWheel` accumulates; press/release sends immediately and cancels any held hover; a non-mouse `dispatchKeyEvent` sends immediately; and `Page.screencastFrameAck` is dropped (server acks frames itself).
- [ ] Batch routing is asserted for all three live paths: when the WS channel reports ready, a flushed batch rides the WS (`{ t: "batch", items }`) and not a POST; when WS is not ready, the batch goes to the streaming/POST fallback; with `inputTransport` pref forced to `batch`, batches use the single-flight POST fallback even after a stream ack.
- [ ] E2E seal/open is covered round-trip with an injected key: a sealed `/api` body posts as `text/plain` and a sealed SSE/`/api` response decodes back to the original object; with no key, bodies are plaintext JSON.
- [ ] Theme push is covered: `setThemeSource`/`getThemeSource` resolve the dark flag (explicit source vs `matchMedia` system), POST `/api/theme` with that flag, and notify every `onNativeThemeChanged` listener.
- [ ] All tests run under Vitest with no real network, no `EventSource`/`WebSocket`/`fetch` from the environment — only injected fakes.
- [ ] No production behavior changes: `cdp-web-transport.ts` is modified only as far as needed to make the shim's seams injectable for the fakes (see Design notes); the shipped runtime path is unchanged.

## Test plan

### Layer 1 — Pure logic (TDD)

This task *is* Layer 1 — characterization tests over the web shim's observable behavior, driven by fakes. Written test-first only where they describe the target behavior; where they pin existing behavior, they're written against the current implementation and must pass against it unchanged.

- [ ] `collapseMoves` — empty, single move, consecutive-move run collapses to latest, run broken by click/wheel/key preserves order and breaks.
- [ ] event fan-out — `cdp`/`disconnected`/`notification`/`notification-activate` each reach all registered listeners once, in order; a screencast-frame `cdp` event still fans out (no frame-tunnel filtering active).
- [ ] `send()` routing — hover held by gate (POST fallback), drag coalesced live, wheel accumulated, press/release immediate + cancels hover, key immediate, `Page.screencastFrameAck` dropped.
- [ ] batch routing — WS-ready rides `{ t: "batch" }`; WS-not-ready uses fallback; `inputTransport=batch` pins single-flight POST.
- [ ] E2E — seal-then-open round-trips an object with an injected key; plaintext path with no key posts JSON.
- [ ] theme push — resolved dark flag from explicit source and from a fake `matchMedia`; POST `/api/theme` fires; `onNativeThemeChanged` listeners notified.

### Layer 2 — Manual smoke (CDP/IPC)

n/a — no main-process, server, or IPC code is touched; the shim is exercised entirely through injected fakes, not a live Remote Browser.

### Layer 3 — Visual review

n/a — no renderer UI is touched. No screencast, sidebar, or overlay changes.

## Design notes

The shim's behaviors under test (fan-out, routing, batching, seal, theme) all sit inside the closure built by the shim's factory and depend on three browser globals it reaches for directly: `fetch`, `EventSource`, and `WebSocket` (plus `matchMedia`, `localStorage`). To test the *current* behavior without network, those reachable dependencies must be injectable. The minimal seam: let the factory accept an optional dependency bag (defaulting to the real globals) so tests pass fakes, and export the factory for the test. This is a test-seam-only change — production calls the factory with no argument and resolves the same globals it does today. No behavioral branch is added or removed.

- **Contracts changed:** none of the `CdpBridge` surface. Internal: the web-shim factory gains an optional injected-dependencies parameter (default = real globals) so the Downlink/Uplink/E2E/theme behaviors are drivable by fakes. The factory and `collapseMoves` become test-reachable exports. `CdpBridge`, `WebCaps`, and every shipped method signature are unchanged.
- **New modules:** a `*.test.ts` beside the web shim under `src/lib/` (Vitest, project convention). Optionally a tiny in-test fakes helper (fake `EventSource`/`WebSocket`/`fetch` with a manual `emit`) kept local to the test file — no new production module, no new shared fake module.
- **New ADR needed?** No. This adds tests and a test seam; it makes no architectural decision. The Downlink/Uplink split (021) is where an ADR, if any, gets written.

Fake-driven seam sketch (shape only, not a path):

```ts
// optional injected deps; production resolves the real globals (current behavior)
interface WebTransportDeps {
  fetch: typeof fetch
  EventSource: typeof EventSource
  WebSocket: typeof WebSocket
  matchMedia?: (q: string) => MediaQueryList
  localStorage?: Pick<Storage, "getItem" | "setItem">
  e2eKey?: CryptoKey | null
}

// a fake exposes manual emit hooks so a test can push a decoded server event
interface FakeEventSource {
  emit(type: "cdp" | "disconnected" | "notification" | "notification-activate", data: string): void
}
interface FakeWsChannel {
  isReady(): boolean
  setReady(v: boolean): void // flip to assert WS-ready batch routing
  sent: Array<{ t: string; [k: string]: unknown }> // captured outbound envelopes
}
```

The tests assert against the **observable contract** (which listeners fire, which envelope/POST goes out, what bytes the seal produces), never against private state — so a 021 refactor that keeps the contract keeps the suite green.

## Out of scope

- The actual Downlink/Uplink seam split, the single dispatcher, the single-site E2E seal, and cutting the default-OFF frame tunnel — all task 021.
- Any change to `transport-selector.ts` (already pure + tested) or `input-coalesce.ts` behavior.
- Server-side (`web/server.mjs`) tests or the proxy→CDP hop.
- Adding new transport behavior, latency tuning, or fixing any quirk the characterization tests reveal — quirks are pinned, not fixed, here.
- Electron preload / `main.js` paths.

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

- The point is a behavior-preserving safety net for 021-023, not coverage for its own sake. Pin what's *observable* from the `CdpBridge` surface and the fakes' captured outputs.
- The default-OFF frame tunnel is slated to be cut in 021 — do **not** write tests that lock its behavior, or they'll have to be deleted next task. Leave it uncovered.
- The streaming input channel's probe/ack handshake is timer- and proxy-dependent; assert the routing decision (stream vs single-flight POST given a ready/not-ready flag), not the probe timing.
- `src/lib/CLAUDE.md` already documents the web-shim routing rules in prose — the tests should match that description; if a test and the prose disagree, the test reflects reality and the prose is the bug (note it, fix in the same commit if trivial).
- The test seam (injected deps) is the only production-file edit allowed here. If making the seam clean turns out non-trivial, stop and flag it rather than smuggling a refactor into a characterization task.

---

_When task status flips to `done`, move this file to `done/`._
