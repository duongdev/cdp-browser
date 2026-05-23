# src/lib — Domain Modules

Six modules that form the renderer's domain layer, plus a React hook that wires them to the component tree. Use the vocabulary from `CONTEXT.md` when reading or changing these files.

## Modules

**`remote-page.ts`** — the Remote Page. `createRemotePage(transport)` wraps the CDP Transport seam into named intentions (`navigate`, `back`, `forward`, `reload`, `selectAll`, `copySelection`, `getNavState`, `isLoading`) and the two subscription surfaces (`on` for typed events, `onFrame` for Screencast Frames). One registration on the raw transport; subscribers come and go — no re-registration, no leaks. Auto-acks every Screencast Frame before passing it to `onFrame` listeners. `forwardInput(InputIntent)` is the single Input Forwarding extension seam: new input kinds (IME, paste, drag) become new variants on `InputIntent` plus one `case` in `forwardInput`; no other interface changes.

**`tabs.ts`** — Tab ordering and lifecycle. `reconcile(order, remoteTabs)` merges the Remote Browser's tab list against the locally-owned order: existing tabs keep position, gone tabs drop out, new tabs append. `nextTab`/`prevTab` wrap around. `createClosedTabStack` tracks closed URLs for Cmd+Shift+T reopen. `stripTitleBadge(title)` strips a leading `(N)` unread count that some apps (e.g. Teams) prepend to the document title — the app surfaces unread counts via its own tab badge, so the title shouldn't duplicate it.

**`viewport-transform.ts`** — Viewport Transform. `letterbox(frame, canvas)` computes the scale and offset when a Screencast Frame doesn't fill the canvas (aspect-ratio mismatch). `toRemoteCoords(client, rect, dpr, frame)` maps a canvas-relative point to Remote Page pixels. Both the draw path in `viewport.tsx` and Input Forwarding hit-testing call these — keeping coordinate math in one place prevents drift.

**`adaptive-viewport.ts`** — Adaptive Viewport. Pure state machine: `deviceMetrics(canvas)` produces the `Emulation.setDeviceMetricsOverride` payload (CSS-pixel dimensions, `deviceScaleFactor` pinned to 1). `reduce(state, event)` drives the controller — `enable`/`disable`, `resize` (canvas changed), `rebaseline` (reconnect without re-applying), `rearm` (user interaction after a graceful back-off — exits dormant and re-imposes client size when `forceOnClient` is on), and `poll` (host-resize detection via drift check). Returns `{ state, effects }` where effects are `applyOverride` or `clearOverride`. No side effects; effects are executed by callers (`app.tsx` / main process).

**`notifications-view.ts`** — Pure presentation logic for the notification popover. `groupByConversation(list)` groups a newest-first `ViewEntry` list into `ConversationGroup` entries keyed by `targetEntity.id` (falls back to title or source). No rendering; tested by `notifications-view.test.ts`. The companion pure store for notification ingestion, dedup, and OS-toast gating is `notifications.js` in the repo root (CommonJS, main-process side).

**`key-routing.ts`** — Pure predicate for macOS OS-reserved key combos. `isOsReservedKey(e: KeyLike)` returns `true` for combos that must fall through to native macOS handlers (Hide, Minimize, Quit, Fullscreen, Cycle Windows). Matches on `e.code` (physical key), not `e.key`, so Option-rewritten characters (e.g. Cmd+Opt+H → "˙") don't break matching. Called by `viewport.tsx` to gate Input Forwarding — reserved combos are neither forwarded nor `preventDefault`ed. Requires `metaKey`; non-Cmd combos always return `false`.

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

## Testing

```bash
pnpm test         # runs all *.test.ts files under src/lib/ via Vitest
pnpm typecheck    # type check
```

Tests use a fake Transport injected into `createRemotePage`. To add a test for a new InputIntent variant, follow the pattern in `remote-page.test.ts`.
