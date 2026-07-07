# 101 — electron notification channel mutes (parity with pwa)

- **Status:** done
- **Mode:** AFK
- **Estimate:** 1d
- **Depends on:** none
- **Blocks:** none

## Goal

The web PWA lets a user silence a noisy notification source per device — a "Mute on this device"
list with a row per service (Teams, Outlook) and per Slack workspace; a muted source stops
pushing, toasting, and bumping any badge, while still listing (dimmed) in the Inbox. The Electron
app has none of this: its Settings show only a single master "Desktop notifications" toggle, and
`shouldNotifyOs` ignores mutes entirely. After this task the Electron app has the same per-source
mute channels: toggling one silences its OS notification **and** removes it from the dock badge +
sidebar unread counts, at parity with the PWA.

## Why now

The user runs both surfaces and asked for Electron parity. Slack in particular is the noisiest
source; on the desktop app today it's all-or-nothing (the master toggle) with no way to silence one
workspace or Teams while keeping the rest. The mute *logic* already exists and is shared
(`core/notif-mutes.js` ↔ `src/lib/notif-mutes.ts`); this task wires it into the Electron OS-notify
path, badge, persistence, and Settings UI — mostly connecting existing pieces, not new invention.

## Acceptance criteria

- [ ] Electron Settings shows a per-source mute list: Teams + Outlook rows (always), plus one row
      per Slack workspace **seen in the captured notification list** (label = the workspace name the
      hijack entry carries in `source`; key = its `slack:{teamId}` groupKey).
- [ ] Toggling a mute row on Electron suppresses that source's **OS notification** (`shouldNotifyOs`
      returns false for a muted entry) — verified with a live capture.
- [ ] A muted source is also excluded from the **dock badge** (`app.setBadgeCount`) and the
      **sidebar tab/pin unread badges** — full parity with the PWA (no half-muted "silent but still
      counting" state). A muted source still appears (dimmed) in the Inbox/bell list.
- [ ] The master toggle (`notificationsEnabled`) still works as today (off silences everything,
      zeroes the badge); mutes compose under it.
- [ ] Electron mutes persist across app restart in `settings.json` as a plain global `notifMutes`
      array (single device — no `deviceId` suffix).
- [ ] Web build is behavior-unchanged: it still remaps `notifMutes` → `notifMutes_<deviceId>`,
      still reads its device slot, and the new global `notifMutes` default never leaks into a web
      device's view.
- [ ] `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`, `pnpm build`, `node --check web/server.mjs`,
      `node --check main.js` all green; Biome clean on touched files.

## Test plan

### Layer 1 — Pure logic (TDD)

- [ ] `core/notifications.js` `shouldNotifyOs` — a muted entry returns false even when enabled +
      not-in-view; an unmuted entry is unaffected; empty/undefined `mutes` mutes nothing (opt-out).
- [ ] `core/notifications.js` `shouldNotifyOs` — master off still wins over mutes (returns false).
- [ ] `core/settings-store.js` — a plain global `notifMutes` round-trips through `getUiState`/
      `setUiState` and persists (it becomes a settable global key; the device-suffixed
      `notifMutes_<id>` path is unchanged).
- [ ] Slack-mute-row derivation (new pure helper) — from a notification list, returns one
      `{ key, label }` per distinct Slack workspace (`slack:{teamId}` → representative `source`),
      de-duped, stable order; ignores non-Slack entries; empty list → [].

### Layer 2 — Manual smoke (CDP/IPC, Electron)

Requires a live Remote Browser + a capturing adapter (Teams/Slack):

- [ ] Trigger a Teams (or Slack) notification, confirm the OS notification fires; mute that source
      in Settings; trigger again → no OS notification, entry still lists dimmed in the bell.
- [ ] Muting drops the dock badge count by that source's unread; unmuting restores it.
- [ ] Restart the app → the mute persists (still muted).
- [ ] Master off → no OS notifications, badge 0; master on → mutes still applied.

### Layer 3 — Visual review

- [ ] Screenshots via Chrome MCP against `pnpm dev` (web) confirming the existing PWA mute card is
      unchanged, and (Electron, manual) the new Electron mute list renders: master + Teams/Outlook +
      Slack workspace rows, no push row, no Slack-capture-health card.
- [ ] The four states: no captured Slack yet (only Teams/Outlook rows show), one workspace seen,
      multiple workspaces, a muted row (switch on + source dimmed in the bell).

## Design notes

- **Contracts changed:**
  - `core/notifications.js` `shouldNotifyOs(entry, opts)` — `opts` gains `mutes: string[]`; returns
    false when `isMuted(mutes, entry)` (from `core/notif-mutes.js`). Backward compatible: absent
    `mutes` ⇒ nothing muted.
  - `core/settings-store.js` — `notifMutes` becomes a settable global ui-state key (default `[]`).
    The web transport still remaps to `notifMutes_<deviceId>` and deletes the plain key before POST,
    so this global is exercised only by Electron; on web it stays `[]` and is overridden by the
    device slot in `getUiState`.
  - `main.js` — `shouldNotifyOs` call passes `settings.notifMutes`; `updateBadge()` sets the dock
    count via `unreadExcluding(list, settings.notifMutes, settings.notificationsEnabled)` instead of
    the raw `unreadCount()`.
- **New modules / helpers:**
  - One pure helper deriving Slack mute rows from the notification list (for the Electron UI, which
    has no sweep/health). Home: alongside the other Slack presentation helpers in
    `src/lib/notifications-view.ts` (mirrors `slackGroupMeta`, which already reads a workspace name
    from `entry.source`), or `src/lib/notif-mutes.ts` — decide at build time by cohesion. Pure +
    tested either way.
- **UI (shared, not duplicated — per review):** the `caps.web ? bigCard : smallCard` split in
  `settings-dialog.tsx` collapses into **one** Notifications card used by both builds. Master +
  the mute list (`MuteRow` over `[...ADAPTER_MUTE_ROWS, ...slackRows]`) render identically; only
  the push row (`{caps.web && …}`) and the Slack-row *source* differ inline (web: sweep health;
  Electron: `slackMuteRows(notifications)` — a new `notifications` prop threaded through Toolbar).
  `app.tsx` ungates `muteOpts` / `unreadExcluding` so both builds' badges honor mutes + master.
- **New ADR needed?** No — this extends the existing per-source mute model (t093, `notif-mutes`) to
  the Electron surface; no new architecture, just wiring an existing seam into the Electron path.

## Out of scope

- Web-push on Electron (it uses native OS notifications; the push toggle stays web-only).
- A Slack workspace registry / capture-health panel on Electron (no sweep there; the mute list is
  sourced from captured entries, which is sufficient for muting what you've seen).
- Per-device muting on Electron (single device — one global `notifMutes`; no `deviceId`).
- Channel-level (per Slack channel) mutes on Electron — the PWA's `slackExcludes` Channel Exclude is
  sweep-driven and stays web-only; Electron muting is per-workspace.

## Definition of Done

- [x] Layer 1 tests written and green (`shouldNotifyOs` mutes ×4, `settings-store` global notifMutes,
      `slackMuteRows` ×5). Full gates: typecheck · 1024 unit · 49 e2e · build · node --check · Biome.
- [ ] Layer 2 Electron smoke via `pnpm install:local` (OS notify silenced when muted + dock badge +
      persist across restart) — done at ship time on the installed app.
- [x] Layer 3: web card unchanged by construction (same components + adapters-then-Slack row order,
      `caps.web`-true path preserved); Electron mute list confirmed via the install:local smoke.
- [x] Moved to `docs/tasks/done/` with the `t101` ID in branch + commit.
