# PSN-93 — [chat] BFF + Persist DB

Goal: put an abstract chat BFF (`apps/chat-server`, Hono + better-sqlite3 + WS) between the existing Teams backend (web/server.mjs's CDP side-channel) and the `/chat` frontend. The BFF owns its own DB, sweeps Teams server-side, pushes deltas to the FE over WS, owns Teams web push, and exposes a service-agnostic `/api/chat/*` contract so more chat services can plug in later. All current features keep working or get better.

## Baseline (probed 2026-07-24)

- Teams stack today: 20+ `POST/GET /api/teams/*` routes in `web/server.mjs` (~line 2750+), every upstream call CA-proof **in-page** via `notificationCenter.runInTeamsPage()` (CDP side-channel to the live Teams tab). Store: `core/teams-store.js` on `web-teams.db` (accounts / conversations / messages / read_state / users / conversation_prefs / settings / messages_fts).
- FE today: `chat/src/lib/teams-client.ts` typed fetch client; polls — thread 4s, list 12s, paused when hidden (except Electron shell list poll). No WS. Electron shell (`chat-main.js`) notifies off the FE list-poll diff; web push subs live in server.mjs (`teams-push-subs.json`).
- Infra: single `cdp-web` compose service (port 7800, `/data` volume). No Hono/Mongo deps. `pnpm-workspace.yaml` exists but has no `packages:` list.
- Live host `100.85.206.8:9222` reachable, Teams keeper tab present.

## Decisions (grilled 2026-07-24)

1. **Monorepo, additive only**: add `packages:` to `pnpm-workspace.yaml`; create `apps/chat-server` as a new workspace package. `chat/` FE, `web/server.mjs`, `core/` stay put this epic (FE move to `apps/` is a future issue).
2. **Upstream seam**: server.mjs keeps the CDP side-channel + creds and exposes a thin **internal Teams provider API**; chat-server calls it as its upstream. No side-channel rewrite.
3. **DB**: better-sqlite3 (not Mongo/Mongoose). chat-server owns its own `chat.db` with a service-agnostic schema. A **Dokploy infra step** is required for the new service (handed to the human — no Dokploy MCP mutations).
4. **Transport**: BFF sweeps Teams (focused conversation fast, list slower), writes DB, pushes deltas to FE over **WS** with poll fallback. FE drops its own poll loops.
5. **Routing**: server.mjs reverse-proxies `/api/chat/*` + the WS upgrade to chat-server. One public origin (portal.dp.dustin.one) unchanged; BFF port internal to compose.
6. **Migration**: none — clean slate. Loss of existing labels/folders/custom titles/read state explicitly accepted.
7. **Backfill**: Settings → Data → last X days (30/60/90/120), default 30, **manual Run only**, progress streamed over WS. Changing X affects the next Run.
8. **Notifications**: BFF owns Teams web push (subs + VAPID send, honoring mutes/notifyOnMention from its DB); Electron shell notify driven by WS deltas instead of list-poll diff. Slack/browser push stays in server.mjs untouched.
9. **API shape**: new service-agnostic `/api/chat/*` contract (`service` discriminator, `teams` first provider). FE refactors `teams-client.ts` → `chat-client.ts`.
10. **Store is a platform, not a cache** (confirmed 2026-07-24): the BFF DB is the durable synced message store for FUTURE background consumers (automation, digests, search, agents) — not just this chat surface. Sweep + backfill write complete, query-friendly rows (raw-ish message payload kept alongside rendered body); store module stays cleanly importable server-side so a future consumer reads the DB or an internal API without touching the chat routes. Existing push subs (`teams-push-subs.json`) are NOT imported — devices re-subscribe on next open (accepted, low current usage).

Fixed by seeds / existing patterns: Hono for BFF HTTP; `ws` (already a dep) for WS; mock upstream + mock BFF for tests following `test/e2e/` harness style; Phase 2 runs Opus orchestrator + Sonnet subagents.

## Architecture

```
/chat FE (PWA + Electron shell)
   │  /api/chat/* + WS (same origin)
web/server.mjs ──proxy──► apps/chat-server (Hono, :7810)
   │                          │  chat.db (own volume path)
   │◄──internal provider API──┘
   │  (in-page Teams fetch via CDP side-channel)
Remote Teams tab (CDP :9222)
```

- **Provider API** (server.mjs, internal-only): the existing in-page executors re-exposed under `/internal/teams/*` (list conversations page, history page, send, react, edit, delete, mark-read, roster, media/avatar/profile bytes, uploads). Guarded so it is only reachable from the BFF (shared secret env or loopback/compose-network bind) — never from the public origin.
- **BFF provider abstraction** (`apps/chat-server/src/providers/`): a `ChatProvider` interface (listConversations, fetchHistory, send, react, edit, delete, markRead, roster, media, uploads); `teams` implementation = HTTP client of the provider API. The mock provider implements the same interface for tests.
- **BFF DB** (service-agnostic): `conversations(service, id, kind, title, last_message_*, sync cursors)`, `messages(service, conv_id, id, sender, ts, body_html, raw JSON, reactions, attachments, deleted, edited, mentions_me)`, `read_state`, `prefs(labels/folder/mute/mutedUntil/notifyOnMention/customTitle)`, `settings`, `users`, `push_subs`. Keys prefixed by `service` so a second service is additive. Per decision 10 the `raw` column keeps the provider payload so future background consumers aren't limited to what the chat UI renders today.
- **WS protocol** (`/api/chat/ws`): client sends `{focus: convId|null}` + auth-less same-origin; server pushes `conversation-upsert`, `messages-upsert`, `read-state`, `backfill-progress`, `presence/health`. Snapshot-on-connect + deltas after.
- **Sweep**: focused conv every ~4s, list every ~12s, all convs' newest page opportunistically; version-gated upserts (same discipline as today's `lastUpdatedMessageVersion`); sweep pauses when no WS client and no push subs? — no: keeps running at list cadence so push still fires with zero clients (that is the point of a BFF).

## Workstreams (each ≈ one session)

| WS | Title | Depends on | Parallel with |
|----|-------|------------|---------------|
| A | Scaffold + contract + store | — | — |
| B | Provider API seam + teams provider + mock upstream | A | C |
| C | WS gateway + server.mjs proxy | A | B |
| D | Sweep engine + backfill engine | B | C |
| E | FE reads on chat-client + WS (list + thread) | C, D | F prep |
| F | FE writes (send/react/edit/delete/uploads/roster/profile/media/prefs) | E | G |
| G | Notifications: web push + Electron shell via WS | D, E | F |
| H | Backfill Settings UI (X days, Run, progress) | D, E | F, G |
| I | Infra: compose service, Dockerfile, Dokploy handoff | B | E–H |
| J | Parity audit + bug sweep + delete old FE-facing /api/teams/* | all | — (last) |

### A — Scaffold + contract + store
`pnpm-workspace.yaml` packages list; `apps/chat-server` package (Hono, better-sqlite3, ws, vitest); `/api/chat` contract types (shared TS defs importable by FE); `chat-store` schema + migrate + upsert/list functions (TDD, mirrors core/teams-store discipline); health endpoint. No upstream yet.

### B — Provider seam
server.mjs: `/internal/teams/*` routes wrapping the existing in-page executors (no logic change, just exposure) + BFF-only guard. chat-server: `ChatProvider` interface, `TeamsProvider` HTTP client, `MockProvider` + a standalone mock-upstream harness for e2e (fake conversations/messages, deterministic).

### C — WS gateway + proxy
chat-server WS endpoint (snapshot + delta protocol above, focus tracking, heartbeat/reap reusing `core/ws-backpressure.js` patterns); server.mjs proxy for `/api/chat/*` HTTP + WS upgrade passthrough (localhost:7810 default, `CHAT_SERVER_URL` env).

### D — Sweep + backfill
Sweep loop (focused/list cadence, version-gated upserts, delta emission to WS layer); backfill engine: cursor-chained history paging per conversation until ts < now − X days, resumable, rate-limit-aware (serial per conversation, small concurrency), progress events. TDD on pure planners; mock-provider e2e proves end-to-end.

### E — FE reads
`chat/src/lib/chat-client.ts` (new contract) + WS client with reconnect/backoff + poll fallback; conversation-list + thread-view consume snapshot+deltas; drop 4s/12s poll loops; existing merge reducers (message-merge, conversation-merge) reused as the delta appliers. Keep-alive panes, scroll model, read-state UX unchanged.

### F — FE writes
All mutations through `/api/chat/*`: reply (rich/quote/mention), reactions, edit/delete, uploads (image/images/file), roster, profile, avatar + media proxy (BFF passes through provider), prefs/labels/folders/customTitle/mute → BFF DB. Optimistic paths + pending-reaction overlay preserved.

### G — Notifications
Move Teams push subs + VAPID send into chat-server (send on sweep delta, honor mute/mutedUntil/notifyOnMention + mentions_me); SW payload/badge parity; Electron shell: `notify-new` fed by WS deltas (works minimized — preserves the PSN-97 fix); notification sounds unchanged.

### H — Backfill UI
Settings → Data card: X-days select (30/60/90/120, default 30), Run button, WS-driven progress (convs done/total, msgs fetched), cancel; disabled while running; empty-DB nudge.

### I — Infra
compose: `chat-server` service (same repo image or second build target, shared `/data` volume path `chat.db`), internal network, env plumbing; Dockerfile multi-app build; `pnpm chat:web` equivalent for dual boot in dev; **Dokploy handoff doc** — exact steps for the human to add the service/volume/env in Dokploy (agent does not mutate Dokploy).

### J — Parity audit + bug sweep (last)
Checklist every current feature (list/thread/send/reactions/edit/delete/uploads/media/lightbox/roster-mention/profile/avatars/read-unread/labels/folders/customTitle/mute/sounds/push/Electron shell/keyboard shortcuts/PWA install) against the BFF path, live via /cdp against the probe host; fix regressions; then remove the FE-facing `/api/teams/*` routes (internal provider routes stay); docs (CLAUDE.md, ADR for the BFF architecture, CONTEXT.md terms).

## Acceptance criteria

- [ ] `apps/chat-server` boots standalone (Hono, own chat.db), `pnpm test` green incl. its unit tests; hermetic e2e runs FE-contract tests against mock provider.
- [ ] `/chat` FE talks ONLY to `/api/chat/*` (no `/api/teams/*` references left in `chat/src`), same public origin, PWA + Electron shell both work unchanged from the user's side.
- [ ] WS live updates: message sent from real Teams client appears in open thread without a FE poll loop; list updates likewise; poll fallback works with WS blocked.
- [ ] Backfill: Settings Run with X=30 fills DB with 30 days of history, progress visible, resumable after restart; changing X honored on next Run.
- [ ] Notifications: web push fires from BFF sweep with zero FE clients open; mutes/notifyOnMention honored; Electron shell notifies while minimized; dock badge + sounds intact.
- [ ] Every feature in the J checklist verified live on the probe host — nothing worse than today.
- [ ] Infra: compose boots both services; Dokploy handoff doc written; deploy verified serving the new commit.
- [ ] Docs: ADR (BFF architecture + provider seam), CLAUDE.md updated, plan ACs checked off.

## Risks

- **Teams rate limits on backfill** — serial paging + delay between pages; backfill is manual-run, resumable; abort on 429 storm with honest progress state.
- **WS upgrade through nginx/Authentik** — known working for `/api/ws` (3-line nginx config); reuse the same path pattern; poll fallback covers failure.
- **Provider API exposure** — internal routes must never be publicly reachable; guard + e2e test that public origin 403s them.
- **Sweep vs cred staleness** — BFF must surface upstream 401/keeper-tab-gone as a typed health state in WS (FE shows Reconnecting banner), not silent staleness.
- **Two processes in dev** — dev ergonomics need one command (concurrently) or the FE dev loop degrades.
- **Clean-slate cutover** — labels/folders/read state reset (accepted); communicate in PR notes.

## Out of scope

- Moving `chat/` FE or `web/server.mjs` into `apps/` (future issue).
- MongoDB/Mongoose, trouter realtime, second chat service implementation (Slack provider) — the interface only.
- Migrating `web-teams.db` data.
- E2E-encrypting the chat surface (chat FE is plaintext today; unchanged).
- Full-text search UI, adaptive cards, file-download proxying beyond current behavior.
