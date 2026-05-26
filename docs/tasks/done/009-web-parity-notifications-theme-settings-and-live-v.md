# 009 — web parity: notifications, theme, clipboard + live verify + docs

- **Status:** done
- **Mode:** AFK
- **Estimate:** 0.5d
- **Depends on:** 007, 008
- **Blocks:** none

## Goal

Close the remaining feature gaps so the web build reaches parity with Electron on
everything that *can* port, verify the whole thing against a live remote browser,
and document the architecture. Notifications fire as web Notification-API toasts
(gated, plus the in-app bell already works via SSE), theme follows the OS
`prefers-color-scheme` via `matchMedia` and is pushed to the remote as emulated
media, and clipboard copy uses `navigator.clipboard`. Ship ADR-0006 + CLAUDE.md.

## Why now

t007 + t008 made the app render and drive the remote. This task makes it feel
complete (notifications, theme, clipboard) and records the decision so the port is
maintainable. It's the last task before the web build is usable end-to-end.

## Acceptance criteria

- [x] An ingested notification fires a web Notification toast when the master
      toggle is on, the tab isn't visible, and permission is granted; clicking it
      re-focuses and routes through the existing notification-activate listeners.
- [x] The in-app bell + per-origin tab badge update from the SSE `notification` push.
- [x] Theme resolves from `themeSource` + `matchMedia`, pushed to the remote via
      `/api/theme` so `prefers-color-scheme` follows the app (verified: Teams dark).
- [x] `copyToClipboard` uses `navigator.clipboard`.
- [x] ADR-0006 + CLAUDE.md describe the web build; `pnpm web` script exists.
- [x] `pnpm test` / `pnpm typecheck` / `pnpm check` green.

## Test plan

### Layer 1 — Pure logic (TDD)

n/a — notification/theme wiring lives in the effectful transport; the pure store
(`notifications.js`) is already tested and reused unchanged.

### Layer 2 — Manual smoke (CDP/IPC)

- [x] Inject a notification via the `__cdpNotify` binding on the live Teams target
      → appears in `/api/notifications` and persists.

### Layer 3 — Visual review (Chrome DevTools MCP against the live host)

- [x] Synthetic notification → bell badge + per-origin tab badge + grouped popover.
- [x] Theme sync: remote page renders dark to match the app.
- [x] Bell popover scrolls (capped viewport) instead of overflowing — see Notes.

## Design notes

- **Contracts changed:** none.
- **New modules:** none (toast/theme logic lives in `cdp-web-transport.ts`).
- **New ADR needed?** yes — `0006-web-proxy-sse-transport.md` (SSE+POST, no-WS
  browser hop, server-side frame acks, capability split). Written this task.

## Out of scope

- Refactoring `main.js` onto the shared core — captured follow-up.
- Real incoming-message OS toast (needs a live message + permission grant) — the
  ingestion path is verified; the toast pop itself is a quick operator confirm.
- Auth/TLS/nginx — operator-owned.

## Definition of Done

- [x] `pnpm test` (162) / `pnpm typecheck` / `pnpm check` green.
- [x] Web build verified end-to-end live (screencast, tabs, settings, theme,
      notifications, scroll).
- [x] ADR-0006 + CLAUDE.md committed.
- [x] No console debris, no AI attribution.
- [x] Task closed: status → done, moved to `done/`, t009 in commit.

## Notes

A scroll bug surfaced during review: the notification bell popover put `max-h-80`
on the ScrollArea root, but the radix viewport is `h-full` — a percentage height
against a max-height parent doesn't resolve, so the list grew unbounded and
couldn't scroll. Fixed by capping the *viewport* instead
(`[&>[data-slot=scroll-area-viewport]]:max-h-80`); verified viewport clientHeight
320 / scrollHeight 1946 / scrolls. The fix is general (helps Electron too).
/polish pass: 1 iteration, 7 fixes (SSE client crash-isolation, invoke listener
race on tab-switch, POST body cap, swallowed errors).
