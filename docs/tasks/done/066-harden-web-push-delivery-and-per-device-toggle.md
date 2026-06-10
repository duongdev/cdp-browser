# 066 — harden web push delivery and per-device toggle

- **Status:** done
- **Mode:** HITL
- **Estimate:** 1d
- **Depends on:** none
- **Blocks:** none

## Goal

Close the Web Push *delivery* holes that drop notifications on the iPad PWA independent of capture. Today a rotated/expired push subscription dies silently, the client only re-subscribes when you toggle the setting, transient push failures are lost with no retry, the `webPush` flag is global (toggling it on one device changes behavior on all), and the 50-entry store cap can evict unread entries. After this task, a delivered notification reaches the device as long as the subscription is recoverable, and per-device push state is independent.

## Why now

Independent of the Slack content sweep (ADR-0011) — this fixes the delivery leg for every adapter today. Fastest win, blocks nothing, so it ships first. ADR-0011 phase 1.

## Acceptance criteria

- [ ] `public/sw.js` has a `pushsubscriptionchange` handler that re-subscribes with the VAPID key and re-POSTs to `/api/notifications/subscribe`.
- [ ] On PWA launch with push on, the client re-validates its subscription and re-POSTs it (idempotent — server dedupes by endpoint).
- [ ] `sendPushToAll` retries once on a transient (non-404/410) failure; 404/410 still prune.
- [ ] The push toggle is per-device, not a single global `webPush` ui-state flag — toggling on device A does not flip device B's in-page toast gate.
- [ ] The notification store cap is raised or partitioned per group so a busy Slack day cannot evict unread Teams/Outlook entries.

## Test plan

### Layer 1 — Pure logic (TDD)

- [ ] cap/partition helper in `core/notifications.js` — eviction no longer drops cross-adapter unread entries.

### Layer 2 — Manual smoke (CDP/IPC)

- [ ] Subscribe on the iPad PWA, force a `pushsubscriptionchange` (reinstall), confirm the server re-receives the subscription and push still arrives.
- [ ] Toggle push off on one device, confirm a second device still toasts.

### Layer 3 — Visual review

- [ ] Settings push toggle reflects per-device state on each device.

## Design notes

- **Contracts changed:** `webPush` ui-state — global flag → per-device. Prefer a device-keyed server entry over localStorage so it survives the PWA localStorage wipe (memory `localstorage-resets-in-pwa`).
- **New modules:** none.
- **New ADR needed?** no — within ADR-0006/0007 scope.

## Out of scope

- The Slack content sweep and anything that changes *capture* (tasks 067–074).
- Web Push for Electron (uses native `Notification`).

## Definition of Done

- [ ] Layer 1 tests green
- [ ] Layer 2 smoke completed on the iPad PWA
- [ ] `pnpm check` / `pnpm typecheck` / `pnpm test` green
- [ ] `node --check web/server.mjs` clean
- [ ] CLAUDE.md updated for modified modules
- [ ] No debris, no AI attribution
- [ ] Task closed: status → done, moved to `done/`, t066 in commit

## Notes

Verify push locally against the deploy before pushing (memory `verify-locally-before-deploy`).

---

_When task status flips to `done`, move this file to `done/`._
