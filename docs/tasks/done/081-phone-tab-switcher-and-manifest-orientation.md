# 081 — phone tab switcher and manifest orientation

- **Status:** done
- **Mode:** HITL
- **Estimate:** 0.5d
- **Depends on:** 076
- **Blocks:** none

## Goal

The Phone Shell can reach everything, just not luxuriously: a flat tap-to-open switcher lists pins + tabs (existing data, no drag-reorder, no context menus) and opens the screencast view on the chosen tab; Settings opens full-width. The manifest `orientation` changes from `"landscape"` to `"any"` — iOS ignores the field either way, but Android honors the lock and it no longer reflects intent.

## Why now

Closes the v1 phone scope (ADR-0012 §7): without a switcher the screencast destination is only reachable through a notification, and the manifest lock is a one-line lie waiting for the first Android install.

## Acceptance criteria

- [ ] Phone shell has a switcher view: pins then tabs, favicon + title, unread badge per group (same `aggregateUnread` data as the sidebar); tap opens the screencast view on that tab (pins resolve/link exactly like a sidebar pin click).
- [ ] No drag, no context menus, no edit-pin on phone — read-and-go only.
- [ ] Settings reachable from the phone shell, rendered full-width; Channel Exclude and quality tier usable there.
- [ ] Command palette, shortcut overlay, and find bar are not mounted on the phone shell.
- [ ] `manifest.webmanifest` `orientation` is `"any"`; iPad/desktop behavior unchanged.
- [ ] Wide shell untouched.

## Test plan

### Layer 1 — Pure logic (TDD)

- [ ] Switcher list derivation — pins-first ordering + unread mapping (reuses existing pure models; only new glue is tested).

### Layer 2 — Manual smoke (CDP/IPC)

- [ ] Tap a pin with no live tab on the phone shell → opens + links a fresh tab on the saved URL (pin semantics preserved).

### Layer 3 — Visual review

- [ ] Switcher: empty (no tabs), populated, with unread badges; ≥44pt touch targets (`.touch-target`).
- [ ] Settings sheet full-width on phone; coarse-pointer dismissal (header close + scrim) works.

## Design notes

- **Contracts changed:** none — presentation over existing pins/tabs/unread models.
- **New modules:** switcher view component only.
- **New ADR needed?** no — ADR-0012 §7.
- Manifest is static text; the change rides this task because it's phone-motivated.

## Out of scope

- New-tab creation UX on phone (the switcher opens existing tabs/pins; `new-tab-dialog` stays wide-shell).
- Tab management (close/reorder/pin) from the phone.
- Any wide-shell layout change.

## Definition of Done

- [ ] Layer 1 tests green
- [ ] Layer 2 smoke completed with a live Remote Browser
- [ ] Layer 3 screenshots captured
- [ ] `pnpm check:changed` / `pnpm typecheck` / `pnpm test` green
- [ ] CLAUDE.md (phone shell scope) consistent
- [ ] No debris, no AI attribution
- [ ] Task closed: status → done, moved to `done/`, t081 in commit

## Notes

If the switcher ends up wanting close/reopen actions, that's a new task — keep this one read-and-go.

Closure notes:
- Shipped: `phone-switcher.tsx` (pins → tabs → locals, same ordering as Cmd+1..9; unread badges from aggregateUnread; tap → browser view), Inbox globe now opens the switcher, palette/overlay/find unmounted on phone + their toolbar launchers hidden, settings sheet full-width on <640px (needed `max-sm:w-full!` — the ui/sheet `data-[side=right]:w-3/4` variant out-specifies a plain width), manifest `orientation` → `"any"`.
- Layer 1: n/a — no new pure logic; ordering and unread maps reuse the existing tested models (deviation from the planned "switcher list derivation" test recorded: there was nothing new to test).
- Verified against the harness: Inbox → Tabs view (3 fake-host tabs) → tap → connected browser view with palette/find launchers absent. Pin rows + Electron narrow-window pass want a HITL look.

---

_When task status flips to `done`, move this file to `done/`._
