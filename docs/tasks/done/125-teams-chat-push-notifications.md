# 125 — teams chat: push notifications (server-poll capture → isolated push sink)

- **Status:** done
- **Mode:** HITL
- **Depends on:** t105 (creds/store), t108 (send), t113 (poll patterns); reuses the web-push spine (VAPID/`webpush`/SW, t093/t095)

## Goal

Deliver a Web Push notification for a new incoming Teams message when the `/chat` PWA isn't open/focused
(iOS 16.4+ installed PWA + Android/desktop). Capture is server-side (no client needed), delivery is
isolated from the existing CDP-browser push so nothing there regresses.

## Decisions (locked with the user 2026-07-22)
- **Scope = every new incoming message** (skip self-authored + system/`ThreadActivity` + reserved convs).
  Per-chat mute *inheritance from Teams* is NOT cleanly available (probed: conversation objects expose
  only `consumptionhorizon`/`favorite`, no mute field; `user/properties` has no per-chat notif map; the
  MT/CSA settings endpoints 404/401). Deferred — the user will add a client-side filter later.
- **Capture = server-side REST poll** (mirrors the Slack sweep), NOT trouter — see t126 (trouter is a
  documented wall). The same poll is the near-realtime path.
- **Isolation:** a SEPARATE subs store (`teams-push-subs.json`) + send path, so the existing
  `/api/notifications/*` push (CDP-browser app) is untouched.

## What shipped

### Server (`web/server.mjs` + `core/`)
- **`core/teams-notify-sweep.js`** (pure, 9 tests) — `planTeamsNotifications({ conversations, state, selfId }) → { notifications, state }`. First run seeds every watermark + emits nothing (no cold-start spam); thereafter emits `{ convId, msgId, ts, senderName, preview }` for each conv whose `lastMessage.ts > watermark` when the sender isn't self (`oidFromMri` tail-match), the messagetype is `Text`/`RichText/Html`, and the conv isn't reserved — always advancing the watermark (strict `>`, ties don't re-emit). `plainText()` strips HTML (mirrors `chat/src/lib/html-to-plain.ts`, cap 140).
- **Capture loop** `teamsNotifySweep()` on a 10s interval (single-flight): guards on no cred / no subs, fetches the RAW conversations page 1 (reuses `fetchTeamsConversationsInPage`, 401→re-authz+retry), runs the planner with `selfId = cred.userId`, persists advanced state to `teams-notify-state.json` (atomic, only on change), `sendTeamsPush(payload)` per notification.
- **`sendTeamsPush`** mirrors `sendPushToAll` (webpush + 404/410 prune) on the isolated `teamsPushSubs`.
- Endpoints: `GET /api/teams/push/vapid-public-key`, `POST /api/teams/push/subscribe {subscription,deviceId?}`, `POST /api/teams/push/unsubscribe {endpoint}`. Subs persist in `teams-push-subs.json` (gitignored).

### Client (`chat/`)
- **`chat/public/sw.js`** — `push` (always `showNotification`, generic fallback on parse-fail → avoids iOS `userVisibleOnly` revocation) + `notificationclick` (focus a `/chat` client + postMessage `{type:"open-conv",convId}`, else `openWindow("/chat?conv=<id>")`). Cache logic untouched.
- **`chat/src/lib/chat-push.ts`** (+ test) — `getVapidKey`/`ensureChatPushSubscription`/`removeChatPushSubscription`/`isChatPushSubscribed` behind a DI seam (ports `src/lib/push-subscribe.ts`; chat/ can't import from src/).
- **`chat/src/components/notify-toggle.tsx`** — header bell toggle; `pushCapable()` HIDES it unless `Notification`+`serviceWorker`+`PushManager` exist AND standalone PWA (matchMedia/`navigator.standalone`).
- **`chat/src/chat-app.tsx`** — `openConversationById` (stub-then-upgrade) + a deep-link effect: reads `?conv=<id>` on load (opens + `history.replaceState`s it away) and listens for the SW `open-conv` message.

### SHARED PAYLOAD CONTRACT
`{ type:"teams", title, body, convId, msgId, ts, tag:convId }` — `title` = sender (1:1) or `"{sender} · {topic}"` (group), `body` = plain-text preview, `tag=convId` collapses repeats.

## Verification (live, 2026-07-22)
- Server pipeline proven end-to-end on the real host: forced a boot sweep with empty-seeded state →
  **`[teams-push] 25 new -> 1 sub(s)`**, the dead test sub got pruned (detect→payload→sendTeamsPush→webpush all ran), watermarks advanced, zero errors. Endpoints subscribe/unsubscribe/vapid all work.
- Deep-link: `GET /chat?conv=48:notes` opens that thread + strips the param.
- Layer 1: 9 sweep tests + chat-push test. Full suite 1335 pass, typecheck 0, `node --check` OK, chat build clean.
- **On-device tail (needs the user):** the actual OS notification render (SW `showNotification`) + lock-screen tap on the installed iPad PWA — SW handlers are code-reviewed; confirm on device.

## Deliberate simplifications (ponytail)
- Sweep reads conversation **page 1 only** (a new message always bumps its conv to the top). Add pagination only if a tenant needs it.
- No per-device mute/unread on the Teams push (simple push-all); deep-link header shows a kind-label until the row loads (payload carries `convId`, not the title).

## Definition of Done
- [x] Server capture→push proven live on real messages; endpoints work; deep-link opens the thread.
- [x] Isolated from the CDP-browser push (separate store + path); state files gitignored.
- [x] Full gates green (1335 tests / typecheck / node --check / chat build). No AI attribution.
- [x] Task → done, `t125` in commit.

## Notes
Isolation is the key safety property — Teams push never touches `/api/notifications/*` or `web-push-subs.json`.
Realtime via trouter was ruled out first — see `done/126-*`.
