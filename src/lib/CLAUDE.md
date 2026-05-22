# src/lib — Domain Modules

Four modules that form the renderer's domain layer, plus a React hook that wires them to the component tree. Use the vocabulary from `CONTEXT.md` when reading or changing these files.

## Modules

**`remote-page.ts`** — the Remote Page. `createRemotePage(transport)` wraps the CDP Transport seam into named intentions (`navigate`, `back`, `forward`, `reload`, `selectAll`, `copySelection`, `getNavState`, `isLoading`) and the two subscription surfaces (`on` for typed events, `onFrame` for Screencast Frames). One registration on the raw transport; subscribers come and go — no re-registration, no leaks. Auto-acks every Screencast Frame before passing it to `onFrame` listeners. `forwardInput(InputIntent)` is the single Input Forwarding extension seam: new input kinds (IME, paste, drag) become new variants on `InputIntent` plus one `case` in `forwardInput`; no other interface changes.

**`tabs.ts`** — Tab ordering and lifecycle. `reconcile(order, remoteTabs)` merges the Remote Browser's tab list against the locally-owned order: existing tabs keep position, gone tabs drop out, new tabs append. `nextTab`/`prevTab` wrap around. `createClosedTabStack` tracks closed URLs for Cmd+Shift+T reopen.

**`viewport-transform.ts`** — Viewport Transform. `letterbox(frame, canvas)` computes the scale and offset when a Screencast Frame doesn't fill the canvas (aspect-ratio mismatch). `toRemoteCoords(client, rect, dpr, frame)` maps a canvas-relative point to Remote Page pixels. Both the draw path in `Viewport.tsx` and Input Forwarding hit-testing call these — keeping coordinate math in one place prevents drift.

**`adaptive-viewport.ts`** — Adaptive Viewport. Pure state machine: `deviceMetrics(canvas)` produces the `Emulation.setDeviceMetricsOverride` payload (CSS-pixel dimensions, `deviceScaleFactor` pinned to 1). `reduce(state, event)` drives the controller — `enable`/`disable`, `resize` (canvas changed), `rebaseline` (reconnect without re-applying), and `poll` (host-resize detection via drift check). Returns `{ state, effects }` where effects are `applyOverride` or `clearOverride`. No side effects; effects are executed by callers (`App.tsx` / main process).

## Transport seam

`Transport` (in `remote-page.ts`) is a structural interface — a subset of `window.cdp`. Tests inject a fake; production uses `window.cdp` directly. Adding a new CDP call never changes the seam; only the `send`/`invoke`/`onEvent`/`onDisconnected` methods matter.

## Hook

**`src/hooks/useRemotePage.ts`** — `useRemotePage()` returns the single Remote Page for the app's lifetime (see `docs/adr/0001-single-remote-page.md`). It holds the instance in a ref so it survives re-renders. The main process swaps the active WebSocket on tab switch, so the Remote Page object itself never needs to be recreated — the transport listener registered once at construction stays valid across all tab switches.

## Key invariants

- Exactly one Remote Page exists at a time. Never create a second one.
- The Transport listener is registered once in `createRemotePage`. Do not call `transport.onEvent` again after construction.
- `Page.screencastFrameAck` is sent inside `createRemotePage`, not in the caller. Callers must not ack frames manually.
- Viewport Transform functions are pure — no state, safe to call from both draw and input paths.
- Adaptive Viewport's `reduce` is pure — all side effects (CDP calls) are executed by the caller, never inside the module.

## Testing

```bash
npm test          # runs all *.test.ts files under src/lib/ via Vitest
npx tsc --noEmit  # type check
```

Tests use a fake Transport injected into `createRemotePage`. To add a test for a new InputIntent variant, follow the pattern in `remote-page.test.ts`.
