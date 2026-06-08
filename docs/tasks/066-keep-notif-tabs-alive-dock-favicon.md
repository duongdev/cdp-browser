# 066 — keep notification tabs alive + favicon on dock/banner

- **Status:** in-progress
- **Mode:** HITL
- **Estimate:** 1d
- **Depends on:** none
- **Blocks:** 067 (service-worker push capture)

## Goal

Background Tabs on the remote browser silently stop delivering notifications: Chromium
freezes idle background tabs (~5 min), which pauses the page JS that the capture script
hooks (`window.Notification`), so only the *active* Tab keeps notifying. After this task,
every Notification-Adapter Tab (Teams / Outlook / Slack) is held in the "active" web
lifecycle state via the side-channel, so background Tabs keep firing notifications. And the
OS notification + the macOS dock icon now carry the source app's favicon, so you can tell
*which* app pinged you at a glance.

## Why now

This is the root cause of "only the focused tab notifies my real machine". It also unblocks
067 (service-worker push capture), which only matters once the page stays alive long enough
to be worth supplementing.

## Acceptance criteria

- [ ] Every adapter-matching Tab's side-channel sends `Page.setWebLifecycleState({state:"active"})` on open.
- [ ] Keep-alive is re-applied on every `reconcile` cycle (browser can re-freeze).
- [ ] Keep-alive does NOT make the page "visible" (Slack must keep firing desktop notifications).
- [ ] OS notification banner shows the source adapter's favicon.
- [ ] macOS dock icon shows the newest-unread app's favicon composited bottom-right; cleared when unread → 0.
- [ ] Dock overlay restores from persisted unread on launch and updates on mark-read/clear.

## Test plan

### Layer 1 — Pure logic (TDD)

- [x] `core/notifications-sidechain.js` keep-alive — sends `setWebLifecycleState active` on open, re-applies per reconcile, not before open.
- [x] `core/notifications.js` `dockOverlayIcon(list)` — newest-unread icon, null when all read / empty / no icon.

### Layer 2 — Manual smoke (CDP/IPC)

- [ ] Open ≥2 Slack workspace Tabs; background one for >5 min; send it a message → OS notification fires on the Mac.
- [ ] Notification banner shows the Slack favicon.
- [ ] Dock icon shows the Slack favicon badge; mark-all-read → badge clears.
- [ ] Teams (`.ico` favicon) renders in both banner and dock (renderer decodes `.ico`).

### Layer 3 — Visual review

- [ ] Dock icon composite looks crisp at retina (white plate + favicon bottom-right).

## Design notes

- **Contracts changed:** `core/notifications-sidechain.js` `sideChannels` map value `ws → { ws, keepAlive }`; new pure `dockOverlayIcon(list)` in `core/notifications.js`.
- **CDP fact (verified vs protocol docs):** `Page.setWebLifecycleState` accepts only `"frozen"|"active"` and governs freeze state, not `document.visibilityState` — so "active" un-freezes without un-hiding.
- **Compositing:** done in the chrome renderer via `executeJavaScript` (its `<img>` decodes `.ico`; favicon bytes are fetched in main and passed as a data URL, so the canvas is never cross-origin-tainted). main turns the returned PNG data URLs into `nativeImage`s for `app.dock.setIcon` + the notification `icon`.
- **New ADR needed?** no — tuning inside ADR-0003 (notifications side-channel).
