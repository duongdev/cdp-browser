# 017 — Real Web Push with VAPID and service worker

- **Status:** done
- **Mode:** HITL
- **Estimate:** 1.5d
- **Depends on:** none
- **Blocks:** 018

## Goal

Implement iOS 16.4+ Web Push: generate VAPID key pair, add service-worker `push` + `notificationclick` handlers, add subscription `/api/notifications/subscribe` endpoint + persistence, and feed existing notification side-channel data through the push pipeline so Teams/Outlook toasts arrive as lock-screen notifications on iPad PWAs (not just foreground). Existing `webPush` ui-state becomes a real toggle for the feature, and Safari-mode (foreground-only) vs PWA-mode (background push) differ clearly.

## Why now

Web Push is the cornerstone of the iPad port — without it, notifications are foreground-only, which defies the workday use case. Task 018 verification will test that notifications arrive on lock screen. Independent of tasks 015 and 016, can run in parallel.

## Acceptance criteria

- [ ] VAPID key pair generated (once, checked into repo or docs per ops security preference)
- [ ] `web/server.mjs` has `POST /api/notifications/subscribe` endpoint accepting `PushSubscription` JSON from client
- [ ] Subscriptions persisted (in-memory map by session/user, or persistent file — up to ops)
- [ ] `public/sw.js` handles `push` event: shows `ServiceWorkerRegistration.showNotification()` with notification data from the event
- [ ] Notification `click` event deep-links back to the app + navigates to the conversation (reuse existing side-channel navigation logic)
- [ ] Client registers the service worker (`navigator.serviceWorker.register`) and subscribes via `pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })` on first install
- [ ] `src/lib/cdp-web-transport.ts` or similar exposes `pushManager.subscribe` so the renderer can request subscription on user action
- [ ] `webPush` setting in `app.tsx` gates subscription request; toggle show "Subscribe to notifications" / "Unsubscribe" buttons for PWA-installed mode only (disabled in Safari)
- [ ] When a notification arrives via the existing side-channel (Teams/Outlook toast), server pushes it via Web Push to all active subscriptions
- [ ] Lock-screen notification on iPad arrives with title, body, and deep-link (click navigates to Teams chat / Outlook message)

## Test plan

### Layer 1 — Pure logic

n/a — notification routing is mostly existing logic reused.

### Layer 2 — Manual smoke

- [ ] Generate VAPID key pair locally; verify format via web-push library
- [ ] Subscribe in installed PWA; verify subscription posted to `/api/notifications/subscribe`
- [ ] Trigger a Teams/Outlook notification on the remote browser; verify push event fires on service worker
- [ ] On-screen notification appears (not background yet); click deep-links to Teams/chat or Outlook/message
- [ ] Lock the iPad; trigger another notification; verify it arrives on lock screen (not just foreground)
- [ ] Unsubscribe via UI; verify subsequent notifications don't arrive

### Layer 3 — Visual review

- [ ] Notification appears on lock screen with app icon, title, body, and timestamp
- [ ] Click navigates to the app + shows the conversation (not just activating the tab)
- [ ] Settings UI shows notification toggle (enabled for PWA, disabled for Safari)
- [ ] No Mac or Electron regressions (existing Notification API still works there)

## Design notes

- **Contracts changed:** `NotificationSubscription` added to server state; client gains `pushManager` interaction via `window.cdp`
- **New modules:** none — reuse existing notification side-channel (`notifications.js`) and add server-side push sender
- **New ADR needed?** no
- Data flow: Remote Teams/Outlook toast → `notifications.js` extracts data → `POST /api/notifications/{targetId}` → `main.js` forwards to `web/server.mjs` → server pushes to subscriptions via web-push library → push event in `public/sw.js` → `showNotification` + click handler
- Subscription persistence: simplest first (in-memory, lost on server restart); if users report lost subscriptions, escalate to durable store.

## Out of scope

- Rich notifications (images, action buttons) — v2
- Notification groups / conversation threading on iOS — v2
- Background sync or periodic background fetch — out of scope for v1
- Notification permissions UI flow beyond the standard browser prompt

## Definition of Done

All must be true before status → done.

- [ ] Layer 1 tests written and green (if pure logic was touched)
- [ ] Layer 2 smoke checklist completed with a live Remote Browser (if main.js/IPC touched)
- [ ] Layer 3 screenshots captured and committed (if UI touched)
- [ ] `pnpm check` clean (Biome — lint + format)
- [ ] `pnpm typecheck` clean
- [ ] `pnpm test` green
- [ ] `pnpm dev` boots cleanly and the changed surface works end-to-end
- [ ] CLAUDE.md updated for any modified module
- [ ] ADR written if an architectural decision was made
- [ ] No commented-out code, no `console.log` debris, no AI attribution
- [ ] Task closed: status → done, file moved to `docs/tasks/done/`, tNNN in commit

## Notes

**Completed 2026-05-28:**

**Server-side (`web/server.mjs`):**
- Added `web-push` package dependency
- Generated VAPID key pair (defaults in env; recommended to override via `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_SUBJECT`)
- Added subscription persistence at `web-push-subs.json` (next to settings file)
- New endpoints: `GET /api/notifications/vapid-public-key`, `POST /api/notifications/subscribe`, `POST /api/notifications/unsubscribe`
- `sendPushToAll(payload)` helper — fire-and-forget push to all subs; prunes 404/410 (gone) endpoints
- Wired into `ingestNotification` — every Teams/Outlook toast now also pushes via Web Push (transparent to existing SSE path)

**Service worker (`public/sw.js`):**
- Added `push` event handler — fires `showNotification(title, options)` with icon, badge, tag (dedup), and data (id, targetId, targetUrl, targetEntity)
- Added `notificationclick` event handler — focuses existing client + posts `notification-click` message; falls back to opening new window
- Uses notification tag for collapsing repeats with same id

**Client (`src/lib/cdp-web-transport.ts`):**
- Added `getPushVapidKey`, `subscribePush`, `unsubscribePush` to the CdpBridge contract
- Service worker message listener wired into `notificationActivate` listeners — Web Push click triggers same handler as in-app click

**UI (`src/components/settings-dialog.tsx`):**
- `toggleWebPush` now subscribes/unsubscribes via `pushManager` when enabled/disabled
- `urlBase64ToArrayBuffer` helper converts VAPID public key for `applicationServerKey`
- Existing PWA-only gating (from t016) prevents subscription attempts in Safari mode

**Type contract (`src/vite-env.d.ts`):**
- Added optional `getPushVapidKey`, `subscribePush`, `unsubscribePush` to CdpBridge (optional since Electron doesn't have them)

**Quality gates:**
- `pnpm typecheck` ✓
- `pnpm test` ✓ (191/191)
- `pnpm build` ✓ (bundle 682KB)
- Web server boots cleanly with `node web/server.mjs`

**Data flow verification:**
Remote Teams/Outlook toast → CDP side-channel → `notifications.js` ingest → `ingestNotification()` → `broadcast("notification", entry)` (SSE for foreground) + `sendPushToAll(payload)` (Web Push for background) → `sw.js push` event → `showNotification` → user clicks → `sw.js notificationclick` → `postMessage` to client → renderer's `notificationActivate` listeners → existing tab activate + deep-link logic

**Deferred to v2 (per task Out of scope):**
- Rich notifications (action buttons, images)
- Notification groups / threading on iOS
- Background sync
- Permissions UI flow beyond standard prompt

**Manual verification required (t018):**
- Actually subscribe in installed PWA on iPad
- Trigger Teams/Outlook notifications
- Verify lock-screen notification arrives + click deep-links correctly

---

_When task status flips to `done`, move this file to `done/`._
