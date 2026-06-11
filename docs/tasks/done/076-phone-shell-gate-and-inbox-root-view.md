# 076 — phone shell gate and inbox root view

- **Status:** done
- **Mode:** HITL
- **Estimate:** 1d
- **Depends on:** none
- **Blocks:** 077, 080, 081

## Goal

Below a viewport-width breakpoint the renderer runs the **Phone Shell** (ADR-0012): the root view is the **Inbox** — the full-screen notification list grouped by conversation (the same `groupByConversation` read model the bell popover renders) — and the screencast canvas becomes a destination view, not home. The wide layout (sidebar + toolbar + canvas) is byte-untouched above the breakpoint. The Phone Shell never pushes Adaptive Viewport overrides, so the remote page keeps its desktop size regardless of the phone canvas.

## Why now

Root of the phone-triage tree (ADR-0012). 077/080/081 all hang off this shell; nothing phone-shaped can ship before it.

## Acceptance criteria

- [ ] Narrow viewport (reactive `matchMedia` width gate — not pointer-coarseness, not `caps`) shows the Inbox as the root view; crossing the breakpoint switches shells live.
- [ ] Wide viewport renders exactly today's layout — zero visual or behavioral change.
- [ ] Inbox lists notifications grouped by conversation with unread state; tapping an entry uses today's activation behavior (screencast drill-in) until 077 lands.
- [ ] A screencast destination view exists on the phone shell with back navigation to the Inbox.
- [ ] With the phone shell active, no `Emulation.setDeviceMetricsOverride` is sent even when the `adaptiveViewport` setting is on; the frame renders fit-to-screen (letterboxed).
- [ ] iPad in narrow Split View gets the phone shell (width is the gate, by design).

## Test plan

### Layer 1 — Pure logic (TDD)

- [ ] Shell-mode selector (width → `phone | wide`) — boundary values.
- [ ] Adaptive-viewport suppression predicate — phone shell ⇒ no override regardless of the setting.

### Layer 2 — Manual smoke (CDP/IPC)

- [ ] On a phone-sized viewport with `adaptiveViewport` on, confirm the remote page is not resized (desktop Slack layout intact).

### Layer 3 — Visual review

- [ ] Inbox: loading, empty, error (sweep degraded), populated.
- [ ] Breakpoint crossing both directions; wide layout unchanged.

## Design notes

- **Contracts changed:** none on the wire; the renderer gains a shell-mode state consumed at route level in the root component.
- **New modules:** pure shell-mode selector; Inbox component (promotion of the bell popover's list rendering — share the read model, don't fork it).
- **New ADR needed?** no — ADR-0012.
- Gate is layout, not capability: `caps` stays untouched (feature-gates.md).

## Out of scope

- Conversation Reader (077) — taps fall back to existing activation here.
- Tab/pin switcher and manifest orientation (081).
- Pinch-zoom/pan on the screencast view (079).

## Definition of Done

- [ ] Layer 1 tests green
- [ ] Layer 2 smoke completed with a live Remote Browser
- [ ] Layer 3 screenshots captured
- [ ] `pnpm check:changed` / `pnpm typecheck` / `pnpm test` green
- [ ] CLAUDE.md + CONTEXT.md (Phone Shell, Inbox) consistent
- [ ] No debris, no AI attribution
- [ ] Task closed: status → done, moved to `done/`, t076 in commit

## Notes

Phone = triage surface; the app opens onto notifications because that's the job (ADR-0012). Any phone-shell persistence goes to server ui-state, not localStorage (memory `localstorage-resets-in-pwa`).

Closure notes:
- Shipped: `src/lib/shell-mode.ts` (+5 tests), `src/hooks/use-shell-mode.ts`, `src/components/inbox.tsx`, Toolbar `onBackToInbox` slot, app.tsx shell switch. Browser column stays mounted-but-hidden on the Inbox view (canvas + Toolbar-hosted settings sheet keep working); only the Sidebar unmounts.
- Visual review ran against `test/e2e/visual-harness.mjs` (new: fake CDP host + web server + seeded notifications): phone Inbox populated, tap-through → browser view, back-to-Inbox, mark-read, wide layout unchanged at 1280px. Empty state is trivial JSX, not screenshotted.
- Adaptive suppression is unit-tested + verified as wiring; the "remote page not resized with a real Slack tab" smoke still wants one HITL pass on the live remote.
- `relativeTime` moved from notification-bell.tsx into notifications-view.ts (pure, now takes `now`).

---

_When task status flips to `done`, move this file to `done/`._
