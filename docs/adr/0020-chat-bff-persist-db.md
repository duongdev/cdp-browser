# ADR-0020: Chat BFF (`apps/chat-server`) — a service-agnostic backend-for-frontend + durable store

- **Status:** Accepted
- **Date:** 2026-07-25

## Context

The Teams chat surface (ADR-0019) grew to ~20 `POST/GET /api/teams/*` routes on `web/server.mjs`,
each an in-page CA-proof Teams call over the CDP side-channel. The `/chat` FE talked to those routes
directly and drove its own freshness — a 4s thread poll + a 12s list poll. Three limits followed:

1. **No durable store as a platform.** `core/teams-store.js` on `web-teams.db` was a render cache for
   the chat UI, coupled into `web/server.mjs`. Nothing else could read synced messages (automation,
   digests, search, agents) without importing the whole web server.
2. **FE-driven freshness.** The poll loops lived in the renderer; a backgrounded PWA / minimized
   Electron shell froze them, so push and unread depended on a client being awake.
3. **Teams-shaped API.** Every route was `teams`-specific. A second chat service (Slack provider,
   future) would mean a parallel route set, not a parameter.

## Decision

Introduce **`apps/chat-server`** — a standalone Hono + better-sqlite3 + `ws` BFF (a new pnpm workspace
package) between the Teams backend and the `/chat` FE. Six moving parts:

- **Provider seam.** `web/server.mjs` keeps the CDP side-channel + Teams creds untouched and re-exposes
  its existing in-page executors under an internal-only **`/internal/teams/*`** API (list/history/send/
  react/edit/delete/mark-read/roster/media/avatar/profile/uploads), guarded by an `x-internal-secret`
  header (`CHAT_INTERNAL_SECRET`). The BFF's `TeamsProvider` is an HTTP client of that API; a
  `ChatProvider` interface + a `MockProvider` let e2e run hermetically.
- **Store as a platform (not a cache).** The BFF owns its own `chat.db` with a **service-agnostic**
  schema (`conversations` / `messages` / `read_state` / `prefs` / `users` / `push_subs`), every key
  prefixed by `service` so a second provider is additive. Each `messages` row keeps the provider payload
  verbatim in a `raw` column alongside the rendered `body`, so a future background consumer isn't
  limited to what the chat UI renders today. The store module stays cleanly importable server-side.
- **WS sweep + deltas.** The BFF sweeps Teams itself (focused conversation ~4s, list ~12s, version-gated
  upserts) and pushes `conversation-upsert` / `messages-upsert` / `read-state` / `backfill-progress`
  deltas to the FE over **`/api/chat/ws`** (snapshot-on-connect, deltas after). The FE dropped its poll
  loops; the existing merge reducers become the delta appliers. The sweep keeps running at list cadence
  with zero clients so push still fires — the point of a BFF.
- **Same-origin proxy.** `web/server.mjs` reverse-proxies `/api/chat/*` HTTP + the `/api/chat/ws`
  upgrade to the BFF (`CHAT_SERVER_URL`, default `localhost:7810`). One public origin unchanged; the BFF
  port stays internal to the compose network.
- **Push ownership.** The BFF owns Teams web push (subs in its DB + VAPID send), firing on its sweep
  deltas and honoring per-conversation mute / `mutedUntil` / `notifyOnMention`. The old server-side
  `teamsNotifySweep` in `web/server.mjs` was removed so a message can't push twice. Slack / browser push
  (`sendPushToAll`) stays in `web/server.mjs`, untouched.
- **Clean-slate cutover.** No data migration — labels / folders / custom titles / read state reset; push
  devices re-subscribe on next open. The FE-facing `/api/teams/*` routes were deleted; `teams-render.js`
  now bakes media `src`s at `/api/chat/media?service=teams&url=…` (BFF → `/internal/teams/media`).

`web/server.mjs`, `chat/` FE, and `core/` stay in place this epic (moving the FE into `apps/` is a
future issue). Dual-process packaging: one image builds both, dev boots them with one `pnpm chat:bff`.

## Consequences

**Easier.** A durable, query-friendly message store any server-side consumer can read; live updates with
no client poll (works while the PWA is backgrounded / the shell minimized — preserves the PSN-97 fix by
feeding Electron `notify-new` off WS deltas); a service-agnostic `/api/chat/*` contract where a second
provider is a new `ChatProvider` impl, not a route fork; a single same-origin surface with the BFF port
private; push that fires with zero clients open.

**Harder.** Two processes to run and deploy (a Dokploy infra step + a `chat:bff` dev command); an extra
network hop (proxy → BFF → `/internal/teams/*`) — mitigated by same-host compose; the internal API must
never be publicly reachable (secret guard + a 403 check); the clean-slate cutover loses existing local
state (accepted, communicated in the PR).

## Alternatives

- **Keep everything in `web/server.mjs`.** Rejected: no platform store, no zero-client push, and the API
  stays Teams-shaped.
- **MongoDB / Mongoose for the store.** Rejected: better-sqlite3 already ships (Electron store), is
  synchronous + embeddable, and the schema is small + relational.
- **Move `chat/` FE into `apps/` this epic.** Deferred: orthogonal churn; the BFF seam doesn't need it.
- **trouter realtime instead of a server sweep.** Rejected earlier (a socket.io tag-doorbell, not a
  message stream; see the Teams realtime findings) — a poll-first sweep is the proven path.
