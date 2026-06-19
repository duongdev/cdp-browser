# ADR-0013: Per-device notification delivery preferences

- **Status:** Accepted
- **Date:** 2026-06-19

## Context

The web PWA is the daily-driver surface across multiple devices at once — phone
+ iPad + desktop, each hitting one server (memory `web-pwa-is-priority-surface`).
Capture is now complete and global: the Slack Content Sweep (ADR-0011) is the
sole authoritative writer, and Teams/Outlook scrape their in-app toast DOM
(ADR-0003). Every captured entry feeds one shared notification store that the
Inbox (ADR-0012) and the bell read.

But **delivery is still one-size-fits-all**: every device gets every web-push,
every foreground toast, and every badge bump. The user's real case is "I already
have the native Teams app on my phone" — the phone should silence Teams while the
desktop keeps it, with each device's home-screen badge staying honest. There is
also a per-device master: the web `notificationsEnabled` toggle was a no-op
because capture never depended on it.

The constraint that shapes the design: nothing may be *silently lost*
(product.md). Muting a source on a device must still **list** the entry in that
device's Inbox/bell (dimmed) — it suppresses the *interruption*, not the record.
And the persistence must survive the iPad PWA's localStorage wipe (memory
`localstorage-resets-in-pwa`), so preferences live in server ui-state, not
localStorage.

## Decision

Split the two concerns: **capture stays global (ADR-0011), delivery becomes
per-device.** A device silences chosen notification sources independently —
per-service for Teams/Outlook, per-workspace for Slack (one row per merged
Enterprise Grid org, ADR-0011 t092).

1. **One mute key unifies both axes.** `muteKey(entry)` = the Slack entry's
   merged `groupKey` (`slack:{groupId}`, t092; `"slack"` when absent), else the
   adapter name. So a mute is per-workspace for Slack and per-service for
   Teams/Outlook with one key space. The pure helper is the single owner:
   `src/lib/notif-mutes.ts` (renderer) mirrored byte-for-byte by
   `core/notif-mutes.js` (server) — the renderer can't import CJS and the server
   can't import the ESM, the same duplication as `core/notifications.js`'s
   `slackGroupKey`. The server never re-derives the key inline.

2. **Preferences are device-keyed ui-state.** A device's mutes persist under
   `notifMutes_<deviceId>` (a set of muted `muteKey`s) and its master under
   `notificationsEnabled_<deviceId>`, written through the existing per-device
   remap seam that already carries `webPush_<deviceId>` (`cdp-web-transport.ts`).
   `core/settings-store.js` round-trips device-suffixed keys by prefix, so they
   survive a PWA refresh. The global `notificationsEnabled` is untouched.

3. **The server gates push per subscription.** Each push subscription record
   carries a `deviceId` (the subscribe endpoint stores it). `sendPushToAll`
   becomes per-subscription aware: for each sub it **skips** the push when that
   device's master is off or its `notifMutes_<deviceId>` includes the entry's
   `muteKey`; otherwise it sends with a **per-device `unread`** (`unreadExcluding`
   — the count with that device's muted sources removed) so the home-screen badge
   is honest per device.

4. **The client gates the foreground.** The foreground web toast (`maybeToast`)
   is suppressed for muted sources on that device; the bell badge, sidebar
   tab/pin badges, and `setAppBadge` mirror all exclude muted sources via
   `aggregateUnread`'s optional `muteOpts` (`{ mutes, master }`, web-only). The
   Inbox/bell **lists** read the unfiltered store and render muted-source entries
   dimmed — interruptions-only, nothing lost.

5. **Gating hierarchy (per device):** master (`notificationsEnabled_<deviceId>`)
   → push opt-in (`webPush_<deviceId>`) → per-source mutes
   (`notifMutes_<deviceId>`). The server enforces master + mutes for push +
   badge; the client enforces them for the foreground toast + bell/sidebar
   badges. Lists always read unfiltered.

6. **Web-only; Electron keeps the global master.** Electron is single-device, so
   it keeps the global `notificationsEnabled` gating `shouldNotifyOs` — no
   per-service mutes, no device keys. The renderer is the single owner of the
   pure helper; the Electron path passes no `muteOpts` so its badge accounting is
   byte-unchanged.

7. **Default is opt-out.** A device with no stored mutes receives everything; a
   subscription with no `deviceId` keeps receiving; a newly-appearing Slack
   workspace defaults on. This preserves the "never silently missing"
   expectation.

8. **Settings surface.** A "Notifications (this device)" card (web-only,
   `caps.web`): master switch, Push toggle, always the three adapters (Teams,
   Outlook, Slack), plus one dynamic row per Slack workspace from
   `/api/notifications/health`. The health surface stays read-only.

This composes with the global, capture-side Channel Exclude (`slackExcludes`,
ADR-0011 t072): excludes silence a channel *everywhere* by removing it from
capture; per-device mutes silence a source's *delivery* on one device while the
entry still lists. They stack and are not re-keyed here.

Reference: task t093.

## Consequences

**Easier:**
- The "native app on my phone" case works: per-device triage without losing the
  desktop's notifications, with each device's badge honest.
- The web `notificationsEnabled` toggle is no longer a dead no-op — it's a soft
  per-device master that doesn't unsubscribe (push opt-in still owns the
  subscription/permission).
- One pure key (`muteKey`) covers both per-service and per-workspace muting, so a
  new adapter or workspace needs no new mute machinery.
- Preferences survive the PWA refresh (server ui-state, not localStorage).

**Harder / costs:**
- `sendPushToAll` is now per-subscription, reading each device's ui-state and
  computing a per-device `unread` — more work per fan-out than a single broadcast
  payload.
- Two copies of the mute helper (`src/lib/notif-mutes.ts` ↔ `core/notif-mutes.js`)
  must stay in sync, like the existing `slackGroupKey` duplication.
- A device-keyed ui-state namespace grows (`notifMutes_<deviceId>`,
  `notificationsEnabled_<deviceId>` joining `webPush_<deviceId>`); stale
  device keys are never garbage-collected.
- The dimmed-but-listed rule means the badge count and the visible list can
  legitimately disagree on a device — intended, but a subtlety to keep documented.

## Alternatives

- **Server-side per-user mute (one set for all devices)** — rejected: defeats the
  whole point; the phone and desktop want different sources.
- **Per-channel-per-device control** — out of scope; `slackExcludes` stays global
  capture-side (mutes a channel everywhere) and composes with this delivery mute.
  No re-key to per-device here.
- **Collapse the master into the push toggle** — rejected: push manages the
  subscription/permission (unsubscribes), the master is a softer per-device mute
  that keeps the subscription; both are kept.
- **Client-only filtering (no server gate)** — rejected: a backgrounded PWA can't
  filter a push it never receives; the gate must be server-side, per
  subscription, for web-push and the home-screen badge to be honest.
- **Off-by-default / opt-in onboarding** — rejected: defaults stay opt-out
  (everything on) to preserve the "never silently missing" expectation
  (product.md).
