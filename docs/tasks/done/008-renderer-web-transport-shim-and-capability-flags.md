# 008 — renderer web transport shim and capability flags

- **Status:** done
- **Mode:** AFK
- **Estimate:** 1d
- **Depends on:** 007
- **Blocks:** 009

## Goal

Make the existing React renderer run unchanged in a plain browser. Add a web
`window.cdp` (`src/lib/cdp-web-transport.ts`) that satisfies the `CdpBridge`
contract over POST + `EventSource` instead of Electron IPC, installed by
`src/main.tsx` only when no preload exists. Add a coalescing batcher
(`src/lib/input-coalesce.ts`) so high-frequency input/acks become one POST per
animation frame, and a `window.webCaps` capability object the UI reads to hide
Electron-only surfaces (local tabs, extensions, the local settings tab), with a
no-op `window.local` so existing callers don't crash.

## Why now

t007 stood up the backend; nothing renders in a browser until the renderer has a
transport that speaks its contract. This is the renderer half. t009 (notification
toast, theme, live verify) builds directly on the installed shim.

## Acceptance criteria

- [x] In the browser, `installWebRuntimeIfNeeded()` installs `window.cdp` (web) +
      `window.local` (no-op) + `window.webCaps`; under Electron it no-ops.
- [x] The web `window.cdp` implements every `CdpBridge` method over `/api/*`.
- [x] Input (`Input.dispatch*`) routes through the batcher: moves coalesce, wheel
      accumulates, discrete flush immediately; `screencastFrameAck` is dropped
      (server acks). One POST/frame, not one per event.
- [x] LOCAL TABS sidebar section, the settings remote/local toggle, and the local
      tabs/extensions settings cards are hidden when `webCaps.localTabs` is false.
- [x] `pnpm test` green incl. the batcher tests; `pnpm typecheck` + `pnpm check` clean.

## Test plan

### Layer 1 — Pure logic (TDD)

- [x] `input-coalesce.ts` `createBatcher` — coalesce keeps latest, append
      accumulates, immediate flushes-then-sends, monotonic `seq`, empty-flush no-op.

### Layer 2 — Manual smoke (CDP/IPC)

n/a — no main.js/IPC change. Transport verified live as part of Layer 3.

### Layer 3 — Visual review (Chrome DevTools MCP against `pnpm web` + live host)

- [x] Web app renders sidebar + toolbar + live screencast over SSE.
- [x] Tab switch reconnects the screencast (verified FWD ↔ Teams).
- [x] Settings drawer shows no Local sections / no remote-local toggle; Connection
      "Test" returns the live browser string.
- [x] Zero console errors.

## Design notes

- **Contracts changed:** none. The web `window.cdp` mirrors the existing
  `CdpBridge`; `window` gains an optional `webCaps`.
- **New modules:** `cdp-web-transport.ts` (web `window.cdp`/`window.local`/caps);
  `input-coalesce.ts` (generic command batcher — pure, tested).
- **New ADR needed?** yes — `0006-web-proxy-sse-transport.md` (written in t009).

```ts
// classification at the transport boundary (raw CDP commands)
Input.dispatchMouseEvent {type:"mouseMoved"} → batcher.coalesce
Input.dispatchMouseEvent {type:"mouseWheel"} → batcher.append
Input.dispatch* (other) / dispatchKeyEvent  → batcher.immediate
Page.screencastFrameAck                      → dropped (server acks)
```

## Out of scope

- Notification API toast, theme matchMedia wiring details, live notification verify
  — t009.
- Touch/mobile input mapping.

## Definition of Done

- [x] Layer 1 tests green.
- [x] `pnpm check` clean (warnings only, consistent with existing code).
- [x] `pnpm typecheck` clean.
- [x] `pnpm test` green.
- [x] Web build boots and the changed surfaces work end-to-end (verified live).
- [x] CLAUDE.md updated (t009 commit).
- [x] No console debris, no AI attribution.
- [x] Task closed: status → done, moved to `done/`, t008 in commit.

## Notes

The renderer never learned it was on HTTP instead of IPC — the `Transport` seam +
`window.cdp` indirection did all the work. Capability gating is a runtime read of
`window.webCaps` (absent ⇒ Electron ⇒ everything shown), not a build flag.
