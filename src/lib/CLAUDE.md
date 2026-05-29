# src/lib — Domain Modules

Domain modules that form the renderer's logic layer, plus a React hook that wires them to the component tree. Use the vocabulary from `CONTEXT.md` when reading or changing these files.

## Modules

**`remote-page.ts`** — the Remote Page. `createRemotePage(transport)` wraps the CDP Transport seam into named intentions (`navigate`, `navigateSpa`, `openTeamsThread`, `back`, `forward`, `reload`, `selectAll`, `copySelection`, `getNavState`, `isLoading`) — `navigateSpa` drives client-side SPA routing (`pushState`+`popstate`, full-navigation fallback) for deep-opening, e.g. an Outlook message from a notification; `openTeamsThread` deep-opens a Teams conversation by clicking the chat row carrying the thread id (Teams has no URL route — see ADR-0003) and the two subscription surfaces (`on` for typed events, `onFrame` for Screencast Frames). One registration on the raw transport; subscribers come and go — no re-registration, no leaks. Auto-acks every Screencast Frame before passing it to `onFrame` listeners. `forwardInput(InputIntent)` is the single Input Forwarding extension seam: new input kinds (IME, paste, drag) become new variants on `InputIntent` plus one `case` in `forwardInput`; no other interface changes.

**`tabs.ts`** — Tab ordering and lifecycle. `reconcile(order, remoteTabs)` merges the Remote Browser's tab list against the locally-owned order: existing tabs keep position, gone tabs drop out, new tabs append. `nextTab`/`prevTab` wrap around. `stripTitleBadge(title)` strips a leading `(N)` unread count that some apps (e.g. Teams) prepend to the document title — the app surfaces unread counts via its own tab badge, so the title shouldn't duplicate it.

**`viewport-transform.ts`** — Viewport Transform. `letterbox(frame, canvas)` computes the scale and offset when a Screencast Frame doesn't fill the canvas (aspect-ratio mismatch). `toRemoteCoords(client, rect, dpr, frame, device?, offsetTop?)` maps a canvas-relative point to Remote Page coordinates (DIP). When the frame is downscaled from the remote layout viewport, pass `device` (the metadata's `deviceWidth`/`deviceHeight`) and it scales frame-px → DIP; omit it and the map is 1:1 (the prior behavior, correct when not downscaled). `dpr` cancels out algebraically, so it never offsets the result. Both the draw path in `viewport.tsx` and Input Forwarding hit-testing call these — keeping coordinate math in one place prevents drift.

**`adaptive-viewport.ts`** — Adaptive Viewport. Pure state machine: `deviceMetrics(canvas)` produces the `Emulation.setDeviceMetricsOverride` payload (CSS-pixel dimensions, `deviceScaleFactor` pinned to 1). `reduce(state, event)` drives the controller — `enable`/`disable`, `resize` (canvas changed), `rebaseline` (reconnect without re-applying), `rearm` (user interaction after a graceful back-off — exits dormant and re-imposes client size when `forceOnClient` is on), and `poll` (host-resize detection via drift check). Returns `{ state, effects }` where effects are `applyOverride` or `clearOverride`. No side effects; effects are executed by callers (`app.tsx` / main process).

**`notifications-view.ts`** — Pure presentation logic for the notification popover. `groupByConversation(list)` groups a newest-first `ViewEntry` list into `ConversationGroup` entries keyed by `targetEntity.id` (falls back to title or source). No rendering; tested by `notifications-view.test.ts`. The companion pure store for notification ingestion, dedup, and OS-toast gating is `notifications.js` in the repo root (CommonJS, main-process side).

**`pins.ts`** — Pin link resolution (a Pin holds a remote tab; see `CONTEXT.md`). `resolvePinLink(pin, targets)` decides a pin's link on startup: persisted `targetId` if still live, else first target whose URL matches the saved URL, else none. `pinForTarget(pins, targetId)` finds the pin owning a target — drives hiding linked tabs from the Tabs list. `dropDeadLinks(pins, targets)` clears links whose target vanished (returns the same reference when unchanged). Pure — no IPC, no tab effects; opening/closing tabs and persistence live in `app.tsx` / main. See `docs/adr/0004-pin-live-tab-model.md`.

**`local-tabs.ts`** — Local tab list logic (a local tab renders as an in-DOM `<webview>`; see `docs/adr/0005`). `LocalTab` is the renderer-held metadata shape. `sortPinnedFirst(tabs)` keeps pinned tabs atop the LOCAL TABS section (stable, returns same ref when already ordered). `toPersisted`/`fromPersisted` are the persistence split — all open local tabs are saved (carrying the `pinned` flag; live-only fields like loading/audio dropped) and rehydrated on launch. Pure; the `<webview>` elements + their event wiring live in `src/components/local-webviews.tsx`.

**`closed-tabs.ts`** — `createClosedStack()` is the unified close-ordered reopen stack. Entries are `{ kind: 'cdp' | 'local', url }`; `pop()` returns the most recently closed of either kind, so Cmd+Shift+T reopens it in its original kind. Pure.

**`active-order.ts`** — MRU (most-recently-used) activation order across both CDP and local tabs. `touchActive(order, entry)` moves an `ActiveRef` (`{ kind, id }`) to the tail (most-recent); `dropActive(order, entry)` removes it; `mostRecent(order, isOpen)` returns the newest entry still open — drives "which tab to activate when the current one closes" across kinds. Pure; no side effects.

**`key-routing.ts`** — Pure predicate for macOS OS-reserved key combos. `isOsReservedKey(e: KeyLike)` returns `true` for combos that must fall through to native macOS handlers (Hide, Minimize, Quit, Fullscreen, Cycle Windows). Matches on `e.code` (physical key), not `e.key`, so Option-rewritten characters (e.g. Cmd+Opt+H → "˙") don't break matching. Called by `viewport.tsx` to gate Input Forwarding — reserved combos are neither forwarded nor `preventDefault`ed. Requires `metaKey`; non-Cmd combos always return `false`.

**`tab-lifecycle.ts`** — Pure close/switch planner. `planClose(input)` resolves what happens when a CDP or local tab closes: which `ClosedEntry` to push, which surface to activate next (MRU across kinds via `active-order.ts`, then first-visible fallback), whether to clear the active surface entirely, and whether a Pin must revert to unlinked. `planSwitch(order, ref)` is a thin named wrapper over `touchActive` so both the switch path and the close path share vocabulary. Pure: no React, no IPC. `app.tsx` executes all effects.

**`unread-aggregator.ts`** — Pure unread-count aggregation. `aggregateUnread(notifications, tabs, pins, linkedTabByPin)` makes one pass over the notification list to build `{ byGroup, byTab, byPin }` count maps. Notifications key by `groupKey ?? originOf(targetUrl)`; a Tab resolves through its own URL origin; a Pin resolves through its linked Tab's live URL (via `linkedTabByPin`) or its saved URL. Replaces the per-origin inline accounting that was scattered across `app.tsx`.

**`notification-activation.ts`** — Activation dispatch registry. `createActivationRegistry()` maps each `ActivateIntent` variant (`spa-link` → `navigateSpa`, `thread` → `openTeamsThread`) to a `RemotePageIntention` (`{ method, arg }`) that `app.tsx` executes as `page[method](arg)` after activating the owning Tab. `resolveActivation(registry, activate)` returns `null` for unknown variants (degrade to Tab-only). Adding a new adapter's deep-open = one new variant in `ActivateIntent` + one entry in the registry; the dispatch loop is unchanged. Pure: no IPC, no Remote Page reference.

## Web transport (web build only)

Seven files in `src/lib/` are not domain modules — they implement the browser-side half of the web transport (WS, SSE + POST) when no Electron preload is present. They live here (not in `src/components/`) because they contain no React and must be unit-testable in isolation.

The transport is split into three named seams assembled by a thin shim:

**`downlink-dispatcher.ts`** — the server→client half. Two pieces:
- `Downlink` — a shallow source abstraction. Exactly one is live at a time (WS-backed or SSE-backed); switching sources tears the prior one down fully so a stale source never leaks.
- `Dispatcher` (`createDownlinkDispatcher`) — the deep module: a decoded inbound message is fanned out to every registered listener of its kind (`cdp`, `disconnected`, `notification`, `notification-activate`), and the OS/web toast fires exactly once per Notification. All paths (SSE `cdp` listener, WS `onEvent`, WS binary-frame) route here; decode/filter/fan-out/toast logic lives in one place.

**`uplink-router.ts`** — the client→server command path. `Uplink` is the seam every outbound command crosses (WS / stream / POST each implement it). `createUplinkRouter({ adapters, advise })` routes each command to the advised adapter if ready, falling through WS → stream → batch, so a command is never dropped. Readiness belongs to the adapters; mode advice comes from `transport-selector.ts`.

**`crypto-context.ts`** — the single owner of E2E in the web build. `createCryptoContext(init)` wraps `crypto-envelope.ts` seal/open into one object (`sealText`/`openText`/`confirm`/`mode`/`ready`). The uplink router seals every client→server body once before it leaves; the downlink dispatcher opens every server→client payload once on the way in. No transport re-touches crypto.

**`cdp-web-transport.ts`** — thin assembler. Constructs a `Downlink`, `UplinkRouter`, and `CryptoContext`, wires them together, and exposes the REST bridge (tabs/config/ui-state/pins/notifications/theme) plus the `CdpBridge` surface as `window.cdp`. Also holds Web Push methods (`getPushVapidKey`, `subscribePush`, `unsubscribePush` — absent under Electron). Routes mouse input: drag (button held) → `batcher.coalesce`; hover (no button) → `hover.move` (bypassed on WS/stream); press/release → `hover.cancel` + `batcher.immediate`; wheel → `batcher.append`. `collapseMoves(items)` — the CDP-specific merge function for `createSingleFlight`.

**`input-coalesce.ts`** — generic batching + backpressure primitives (no CDP-specific logic):
- `createBatcher<T>` — coalesces high-frequency commands onto a scheduler (one POST per rAF instead of one per event).
- `createHoverGate<T>` — holds a buttons-up move and emits it only once the cursor stops (injected `delay`); `cancel()` drops the held move. Keeps hover from flooding the POST fallback.
- `createSingleFlight<T>` — at most one `post` in flight; items pushed while waiting accumulate and `merge` into one next post on settle. Bounds the POST rate to link RTT. A failed post does not wedge the queue.

**`crypto-envelope.ts`** — browser-side AES-256-GCM seal/open primitives. `deriveKey(passphrase, salt)` runs PBKDF2-SHA256; `seal(key, obj)` / `open(key, ct)` wrap SubtleCrypto. No state; pure crypto. Used by `crypto-context.ts`; mirrors `crypto-envelope.js` (server side, CJS).

**`transport-selector.ts`** — pure mode-selection state machine (t019). Models the Auto chain (WS → Stream → Batch), per-mode retry bounds (3 attempts), last-good cache via injected `localStorage`-shaped store, manual-pick error tracking, and the degraded → re-probe-on-focus transition. No I/O — the actual WS open/close lives in `cdp-web-transport.ts`; the selector only advises the router. See ADR-0007.

## Transport seam

`Transport` (in `remote-page.ts`) is a structural interface — a subset of `window.cdp`. Tests inject a fake; production uses `window.cdp` directly. Adding a new CDP call never changes the seam; only the `send`/`invoke`/`onEvent`/`onDisconnected` methods matter.

## Hook

**`src/hooks/use-remote-page.ts`** — `useRemotePage()` returns the single Remote Page for the app's lifetime (see `docs/adr/0001-single-remote-page.md`). It holds the instance in a ref so it survives re-renders. The main process swaps the active WebSocket on tab switch, so the Remote Page object itself never needs to be recreated — the transport listener registered once at construction stays valid across all tab switches.

## Key invariants

- Exactly one Remote Page exists at a time. Never create a second one.
- The Transport listener is registered once in `createRemotePage`. Do not call `transport.onEvent` again after construction.
- `Page.screencastFrameAck` is sent inside `createRemotePage`, not in the caller. Callers must not ack frames manually.
- Viewport Transform functions are pure — no state, safe to call from both draw and input paths.
- Adaptive Viewport's `reduce` is pure — all side effects (CDP calls) are executed by the caller, never inside the module.
- Notifications View (`notifications-view.ts`) is pure — no I/O, no IPC. Effects and persistence live in `main.js`.
- Key Routing (`key-routing.ts`) is pure — no DOM access, no side effects. Callers decide what to do (skip forward, skip `preventDefault`).
- Pins (`pins.ts`) is pure — it resolves links over data only. Opening/closing tabs, persistence, and IPC live in `app.tsx`/main. `targetId` is a hint, always revalidated against the live target list.
- Active Order (`active-order.ts`) is pure — returns new arrays, never mutates. Callers hold the array in state; `app.tsx` drives effects (which tab to activate on close).
- Tab Lifecycle (`tab-lifecycle.ts`) is pure — returns directives, never executes them. `app.tsx` applies every effect (close the target, swap the active surface, push the Closed Tabs entry, revert the Pin, persist).
- Unread Aggregator (`unread-aggregator.ts`) is pure — `aggregateUnread` is a plain function over data. `app.tsx` supplies `linkedTabByPin` and holds the result in state.
- Notification Activation (`notification-activation.ts`) is pure — no Remote Page reference, no IPC. `app.tsx` calls `page[method](arg)` after resolving the intention.
- Downlink Dispatcher (`downlink-dispatcher.ts`) is pure (lib-style) — fan-out + toast-once gating only. WS/SSE attach, E2E decode, and the actual OS/web toast effect stay in `cdp-web-transport.ts`, which injects the toast and decodes before calling `dispatch`.
- Uplink Router (`uplink-router.ts`) is pure — holds no socket, opens no fetch. Adapter readiness and mode advice are injected; the router owns only the pick logic.
- Crypto Context (`crypto-context.ts`) is pure — wraps `crypto-envelope.ts` primitives, holds no socket. The wire format (plaintext JSON or base64 AES-GCM) is byte-identical to the pre-seam baseline.

## Testing

```bash
pnpm test         # runs all *.test.ts files under src/lib/ via Vitest
pnpm typecheck    # type check
```

Tests use a fake Transport injected into `createRemotePage`. To add a test for a new InputIntent variant, follow the pattern in `remote-page.test.ts`.
