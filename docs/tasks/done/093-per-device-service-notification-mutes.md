# 093 — per-device per-service notification mutes

- **Status:** done
- **Mode:** HITL
- **Estimate:** 1d
- **Depends on:** 092
- **Blocks:** none

## Goal

Each client/device can silence chosen notification sources independently — **per-service** for Teams/Outlook, **per-workspace** for Slack (one row per merged Grid org, from t092). Muting a source on a device means: no web-push, no foreground toast, no badge bump **on that device** — but the Inbox/bell still *list* the entry (dimmed) so nothing is silently lost. Capture stays global (ADR-0011: the sweep is the sole Slack writer feeding the Inbox/Reader). After this task, the user's "I already have the Teams app on my phone" case works: the phone mutes Teams while the desktop keeps it, with the home-screen badge staying honest per device.

## Why now

The web PWA is the daily-driver surface across multiple devices (phone + iPad + desktop) hitting one server; today every device gets every notification. This is the most-requested triage control and the reason the phone surface (ADR-0012) exists. t092 must land first so the Slack rows it lists are already deduped (one "Example Group", not two).

## Acceptance criteria

- [x] `muteKey(entry)` = `entry.groupKey` for Slack, else `entry.adapter` (pure, tested in `core/notif-mutes.js` + `src/lib/notif-mutes.ts`).
- [x] Per-device mutes persist in ui-state `notifMutes_<deviceId>` and **survive a PWA refresh** — verified live: a `POST /api/ui-state {notifMutes_<id>}` round-trips through `GET`; `settings-store.js` now passes device-suffixed keys by prefix allowlist (was silently dropping them — also fixed the latent `webPush_<deviceId>` persistence gap).
- [x] Each push subscription record carries a `deviceId`; the subscribe endpoint stores it; `subscribePush` sends `getOrCreateDeviceId()`.
- [x] `sendPushToAll` skips a subscription when its device muted the entry's `muteKey` **or** the device's master is off; otherwise sends with a **per-device `unread`** (`unreadExcluding`).
- [x] The foreground web toast (`maybeToast`) is suppressed for muted sources / master-off on that device.
- [x] Home-screen badge + bell badge use `unreadExcluding`; sidebar tab/pin badges via `aggregateUnread`'s optional mutes arg; the Inbox/bell **list** still shows muted entries (dimmed at opacity-50).
- [x] `notificationsEnabled` repurposed: web reads/writes `notificationsEnabled_<deviceId>` (per-device master); Electron unchanged (global, gates `shouldNotifyOs`). The web master toggle is no longer a no-op.
- [x] Settings shows a web-only "Notifications (this device)" card: master, Push, Teams, Outlook, + one row per Slack workspace from `/api/notifications/health` (post-t092 merged rows).
- [x] Default opt-out: no stored mutes ⇒ everything delivered; a newly-appearing workspace defaults on (tested).

## Test plan

### Layer 1 — Pure logic (TDD)

- [x] `notif-mutes` — `muteKey`, `isMuted`, `toggleMute` (no-mutate), `unreadExcluding` (0 when master off) — both `core/notif-mutes.test.ts` (14) + `src/lib/notif-mutes.test.ts` (17).
- [x] Per-device unread — same list, two mute sets → two different counts (tested both sides).
- [x] Default semantics — absent key ⇒ not muted; `aggregateUnread` mutes arg optional (no-arg byte-unchanged).

### Layer 2 — Manual smoke (CDP/IPC)

- [x] Device-keyed ui-state round-trip verified live: `POST {notifMutes_<id>:[...], notificationsEnabled_<id>:false}` → `GET` returns them; unknown-prefix key dropped. (The core persistence fix.)
- [x] Server boots on the new code; `/api/notifications/health` still returns `{ rows, groups }` (Example merged, Example-Team separate).
- [ ] HITL: two real PWA installs with different mutes → push divergence + per-device badge (needs two devices + live messages — flagged for your return).

### Layer 3 — Visual review

- [ ] Deferred to HITL — no debug Chrome in the AFK env. Settings card + dimmed Inbox to screenshot on next desktop session (logic + wiring unit-verified; `caps.web`-gated).

## Design notes

- **Contracts changed:**
  - ui-state — new device-keyed keys `notifMutes_<deviceId>: string[]` and `notificationsEnabled_<deviceId>: boolean`, written via the existing per-device remap seam (mirrors `webPush_<deviceId>` in `cdp-web-transport.ts`). The global `notificationsEnabled` stays for Electron.
  - Push subscribe payload + stored sub record — add `deviceId`.
  - `sendPushToAll` — becomes per-subscription aware: gate by `notificationsEnabled_<deviceId>` then `notifMutes_<deviceId>`, and stamp a per-device `unread`.
- **Gating hierarchy (per device):** master (`notificationsEnabled_<deviceId>`) → push opt-in (`webPush_<deviceId>`) → per-source mutes (`notifMutes_<deviceId>`). Server enforces master + mutes for push + badge; client enforces them for the foreground toast + bell/sidebar badges. Lists (Inbox/bell) read **unfiltered**.
- **New modules:** `src/lib/notif-mutes.ts` (pure helpers above). The server computes `muteKey` inline (one line over `entry.adapter`/`entry.groupKey`); keep the renderer the single owner of the helper to avoid a second copy drifting.
- **New ADR needed?** Yes — short ADR "per-device notification delivery preferences" (extends ADR-0006 transport / ADR-0011 capture / ADR-0012 phone): capture is global, *delivery* is per-device, gated server-side per push subscription via `deviceId`, persisted in device-keyed ui-state.

```ts
// the mute key unifies per-service (teams/outlook) and per-workspace (slack)
const muteKey = (e: { adapter: string; groupKey?: string }) =>
  e.adapter === "slack" ? (e.groupKey ?? "slack") : e.adapter

// server, per subscription:
//   if (!notificationsEnabled_[sub.deviceId]) skip
//   if (notifMutes_[sub.deviceId].includes(muteKey(entry))) skip
//   else send({ ...payload, unread: unreadExcluding(list, mutes, true) })
```

## Out of scope

- Electron per-service mutes — web-only for now (Electron is single-device; its global `notificationsEnabled` already gates its OS toast).
- Per-channel-per-device control — `slackExcludes` stays **global capture-side** (mutes a channel everywhere); it composes with (does not duplicate) this per-device delivery mute. No re-key to per-device here.
- Off-by-default / opt-in onboarding — defaults stay opt-out (everything on) to preserve the "never silently missing" expectation (product.md).
- Collapsing the master into the push toggle — keep both (push manages the subscription/permission; master is a softer per-device mute that doesn't unsubscribe).

## Definition of Done

- [x] Layer 1 tests written and green (884 unit tests total; +33 for notif-mutes + aggregateUnread)
- [x] Layer 2 smoke — device-keyed ui-state persistence + health verified live (two-real-device push divergence is HITL)
- [ ] Layer 3 settings-card + Inbox screenshots — deferred to HITL (no debug Chrome AFK)
- [x] `pnpm typecheck` clean, `pnpm test` green, `pnpm test:e2e` green; Biome 0 errors on touched files
- [x] `node web/server.mjs` boots; per-device prefs persist + gate end-to-end (unit + live round-trip)
- [x] CLAUDE.md + `src/lib/CLAUDE.md` updated; new ADR-0013 written; ADR index in docs-discipline.md fixed (was stale at 0011)
- [x] No debris, no AI attribution
- [x] Task closed: status → done, moved to `docs/tasks/done/`, `t093` in branch + commit

## Notes

Decisions from the grilling session (2026-06-19): per-device delivery-only (Q1); per-service + per-Slack-workspace (Q2); server-side gate with `deviceId` on the sub + `notifMutes_<deviceId>` in ui-state + per-device unread (Q3); interruptions-only, lists still show dimmed (Q4); repurpose `notificationsEnabled` as the per-device master (Q5); dedicated settings card, always-show 3 adapters + dynamic Slack workspaces, health card stays read-only (Q6).

---

_When task status flips to `done`, move this file to `done/`._
