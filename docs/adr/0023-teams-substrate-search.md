# ADR-0023: Teams Substrate Search as the global-search data plane

- **Status:** Accepted
- **Date:** 2026-07-28

## Context

The chat app's `chat.db` holds only what the BFF has swept — the focused conversation plus recently-bumped ones (ADR-0020). All search read only that local subset: the assistant's `search_messages` FTS tool and the (then non-existent) message-search UI could never surface a message the sweep had not already pulled. A term that exists in Teams but not yet in `chat.db` returned "nothing in synced history".

Backfilling the whole tenant into `chat.db` was rejected before this epic (ADR-0020, and PSN-115 decision 2): every Teams call funnels through the single in-page keeper tab, so an eager crawl of all history is a rate-limit and storage cost with no bounded finish line.

Teams itself has a server-side full-text search — **Substrate Search** (`substrate.office.com/search/api/v2/query`) — that indexes the user's entire mailbox and Teams history server-side. Live-probed 2026-07-28 against a real tenant:

- The Teams tab caches a substrate MSAL token (`substratesearch-internal.readwrite`, audience `substrate.office.com`) in `localStorage`. No new mint chain — read it in-page like the existing skypetoken/graph scripts, with `msal.acquireTokenSilent` as the 401 fallback.
- `POST` with `EntityRequests:[{ EntityType:"Message", ContentSources:["Exchange","Teams"], … }]` returns real `IPM.SkypeTeams.Message` chat hits. `ContentSources:["Exchange"]` alone returns only mail `IPM.Note` — **the `"Teams"` source is load-bearing**.
- Each Teams hit carries `ClientThreadId` = `19:…@thread.tacv2` (our `convId`) and `ClientConversationId` = `19:…@thread.tacv2;messageid=<nativeMsgId>` (our `msgId`), plus `Preview`, `From`/`FromDisplayName`, `DateTimeReceived`. So a hit maps cleanly back to `chat.db` identity with no extra lookup.

## Decision

Global search is **hybrid: local FTS fast path, Substrate live fallback, lazy hydrate**. Substrate is the reach; `chat.db` stays the local store; nothing is crawled eagerly.

- **Substrate is the upstream fallback, on demand only.** Local FTS over `messages_fts` is always tried first. Substrate is queried in parallel for the same free-text term (and as the sole leg when the term is absent from `chat.db`). No background crawl — a query is the only trigger, so cost tracks real use.
- **The request/parse split is pure.** `core/teams-substrate.js` owns the request-body shape, the header mask, `mapHttpError` (401→`auth`, 429→`rate_limited`, else `upstream_error`), and the hit → `{convId, msgId, preview, sender, ts}` parser. It is defensive throughout: a malformed `Result`, a non-`IPM.SkypeTeams.Message` `ItemClass`, or a hit missing a `messageid=` segment is dropped, never thrown. The effectful call — the CA-proof in-page `fetch` via `runInTeamsPage`, token read + silent-acquire retry — lives in `web/server.mjs`'s `/internal/teams/search`, so the schema stays unit-testable without a live tab (mirrors the `teams-creds.js` / `teams-cursor.js` split).
- **A hit hydrates its conversation window, lazily.** `apps/chat-server/src/hydrate.ts` (planner in `hydrate-plan.ts`) takes a substrate hit whose message isn't in `chat.db` and pages that conversation backward via the existing `provider.fetchHistory` — the same paging the sweep and manual backfill use — upserting through `store.upsertMessages`, which also syncs the FTS shadow index so a local re-query finds the newly-landed term. It is idempotent (an already-present message is a no-op), single-flight per conversation (N hits in one conv share one fetch pass), page-bounded (`MAX_HYDRATE_PAGES`), and 429/auth-aware. It never throws: a hit that can't hydrate (R4 — deleted, Grid edge, gone from msg-service) still renders from its substrate `preview`.
- **Hydrate completion rides the existing `messages-upsert` WS delta, not a new channel.** Because hydrate goes through `store.upsertMessages`, the BFF's existing WS hub (`/api/chat/ws`, ADR-0020) already fires a `messages-upsert` delta for the newly-inserted rows. The open search view is already subscribed to that hub, so it flips `hydrated:false` rows in place with zero new transport. A dedicated `hydrate-progress` frame (mirroring `backfill-progress`) is deliberately deferred — the row-flip covers the UX.
- **`POST /api/chat/search` is one request-response, service-agnostic.** It merges the local FTS leg and the substrate leg, dedupes by `(convId,msgId)` with **local winning** (the authoritative hydrated copy with an FTS snippet replaces a substrate preview), applies the parsed KQL filters (`from`/`in`/`after`/`before`/`has`/`mentions:me`, pure `search-query.ts`) uniformly across both legs, honours Relevance⇄Recent sort + scope, and returns `{ rows, parsed, degraded? }`. `degraded` marks a local-only result when substrate 401/429/errors — the search still returns, never crashes.

## Consequences

- Search reaches all of the user's Teams history, not just the swept subset, while `chat.db` stays a bounded store that self-heals only the windows a query actually touches.
- The assistant's retrieval tools inherit the same reach: thin/zero local hits fall through to substrate → hydrate → local re-query, so the model cites real rows for a term that wasn't local before the turn.
- Search now depends on an **undocumented** Microsoft endpoint and response schema (R2). The parser is defensive and log-and-degrades to local-only on a shape change, but a substrate change could regress global reach (never the local fast path).
- The substrate token expiry path (R1) is handled by an in-page `acquireTokenSilent` retry; a silent-acquire failure is a typed `auth` degrade, not a crash.
- Hydrate fans `fetchHistory` calls through the same single in-page keeper tab as the sweep (R3); concurrency is capped, single-flight per conv, page-bounded, and visible hits hydrate first.
- Teams-only. The contract carries a `service` discriminator so a future Slack (or other) global-search leg is additive, but no non-Teams wiring exists here.

## Alternatives

- **Eager backfill of all history into `chat.db`.** Rejected (ADR-0020, decision 2): unbounded cost through the single keeper tab with no finish line. Search over a complete local DB would be simpler to reason about but is exactly the crawl this design avoids.
- **A new SSE (or `hydrate-progress` WS) channel for hydrate completion.** Rejected as premature: `store.upsertMessages` already emits a `messages-upsert` delta the search view consumes, so a second channel is redundant transport. Kept as a one-line add (`HydrateDeps.broadcast`) only if row-flip UX proves insufficient.
- **A generic provider search client.** Rejected: the substrate schema is Teams-specific (`IPM.SkypeTeams.Message`, `ClientThreadId`, `ContentSources`). A generic seam would abstract over exactly one implementation. The `ChatProvider.searchMessages` seam stays service-agnostic; its Teams impl is deliberately concrete.
- **Server-side `fetch` to substrate (like the Slack sweep, ADR-0011).** Rejected: a Conditional-Access device/IP binding rejects an off-box call. Every Teams call runs in-page from the browser's own session/egress (ADR-0019), and substrate is no exception.
- **Substrate as the only search path (drop local FTS).** Rejected: local FTS is the fast, offline-capable, always-fresh path for already-synced content; substrate is Microsoft-ranked, network-bound, and rate-limited. The hybrid keeps the fast path and adds reach only on demand.
