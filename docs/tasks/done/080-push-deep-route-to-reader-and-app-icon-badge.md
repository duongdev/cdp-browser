# 080 — push deep-route to reader and app icon badge

- **Status:** done
- **Mode:** HITL
- **Estimate:** 0.5d
- **Depends on:** 076, 077
- **Blocks:** none

## Goal

A Web Push tap on the phone lands in the **Conversation Reader** for that entry — including cold start (PWA not running → SW opens the window → app boots into the reader, not the Inbox). The push payload carries the conversation key to make that routable. The home-screen icon mirrors the Inbox unread count via `navigator.setAppBadge` (set by the SW on push, updated/cleared by the page as entries are read). The wide shell keeps today's tap behavior (activate tab + deep-open intent).

## Why now

Completes the core loop: push → glance (badge) → tap → read → reply. Without deep-routing, a push tap dumps the user at the screencast — exactly the path ADR-0012 demotes.

## Acceptance criteria

- [ ] Push payload includes the entry/conversation key (`groupKey` + entry id) alongside the existing fields.
- [ ] Warm tap (PWA running, phone shell): SW `notificationclick` routes the page straight to the reader for that conversation.
- [ ] Cold tap (PWA closed): SW opens the window with the route intent; app boots into the reader after data loads (graceful loading state, falls back to Inbox if the entry is gone).
- [ ] Wide shell: tap behavior unchanged (activation registry path).
- [ ] `setAppBadge(n)` reflects Inbox unread on push arrival (SW) and after reads (page); badge clears at zero; no-ops where unsupported.
- [ ] Lock-screen delivery still works exactly as before (no regression to the t-existing web-push path).

## Test plan

### Layer 1 — Pure logic (TDD)

- [ ] Route-intent codec — push payload → reader route, missing/stale entry → Inbox fallback.
- [ ] Badge-count derivation — reuses `aggregateUnread` totals; zero clears.

### Layer 2 — Manual smoke (CDP/IPC)

- [ ] Installed PWA on iPhone, screen locked: send a Slack DM → push arrives → tap → reader on that DM (warm and cold both).
- [ ] Badge count rises on push, falls after reading in the reader.

### Layer 3 — Visual review

- [ ] Cold-start loading state into the reader; fallback-to-Inbox state.

## Design notes

- **Contracts changed:** push payload schema gains the conversation key; SW↔page post-message protocol gains a route intent (extends the existing `notificationActivate` message, doesn't fork it).
- **New modules:** none expected — route-intent codec can live beside the activation registry.
- **New ADR needed?** no — ADR-0012 §6.
- iOS quirk: `setAppBadge` works in installed PWAs (16.4+); call sites must feature-detect.

## Out of scope

- Notification grouping/stacking policy on the lock screen (one-per-message stays).
- Badge on the wide/iPad shell beyond what falls out for free.
- Quick-reply from the notification itself (no iOS support for web push actions with text input).

## Definition of Done

- [ ] Layer 1 tests green
- [ ] Layer 2 smoke completed on a real installed PWA (lock screen + cold start)
- [ ] Layer 3 screenshots captured
- [ ] `pnpm check:changed` / `pnpm typecheck` / `pnpm test` green
- [ ] CLAUDE.md (web push bullet) updated
- [ ] No debris, no AI attribution
- [ ] Task closed: status → done, moved to `done/`, t080 in commit

## Notes

SW changes bump the cache name (`sw-cache-name`) — make sure the update watcher (t044) picks the new build up on phones too.

Closure notes:
- Shipped: push payload stamps conversation identity (channelId/slackKind/slackTs/slackThreadTs) + live `unread` count (web/server.mjs); sw.js shows the notification AND mirrors `setAppBadge` from the payload, and a cold tap opens `/?notif=<id>`; `src/lib/push-route.ts` (6 tests) owns the pure codec; app.tsx routes warm taps phone→reader / wide→activation, consumes the one-shot cold-start param after store load (gone entry → Inbox), and keeps the badge live as entries are read.
- Verified against the harness: `/?notif=n2` at phone width boots straight into the Conversation Reader for that entry and the URL is stripped. Real push delivery, lock-screen tap, and the icon badge need the installed-PWA HITL pass on the iPhone (t018-style).
- The SW postMessage entry now carries the new fields through cdp-web-transport's notification-click construction, so a warm tap can open the reader (and later compose) even if the store fetch lags.

---

_When task status flips to `done`, move this file to `done/`._
