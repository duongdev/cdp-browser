# PSN-115 — Proactive Backfilling + Global Message Search

Epic. Plan-only until the label flips to `build`. Same issue, same branch (`chat-proactive-backfilling`), ONE PR.

## Goal

Make chat data self-heal from upstream Teams APIs when it isn't in the local `chat.db`, and ship the first user-facing consumer: a full-screen, Slack-style **global message search**. Local FTS stays the fast path; a search miss (or an explicitly global query) fans out to Teams' server-side **Substrate Search API**, maps hits back to `(convId, msgId)`, and hydrates the matched conversation windows into `chat.db` so repeat reads and AI context are local.

This is the data-plane + first surface for global message search. Teams-only. Web/BFF only (Electron `/chat` shell inherits it through the server).

## Baseline (probed 2026-07-28, not assumed)

- **Backfill mechanism already exists** — `apps/chat-server/src/backfill.ts` + `backfill-plan.ts`: manual, Settings-triggered, pages each conversation BACKWARD via `provider.fetchHistory` cursor to a `now − days` cutoff. Serial, rate-limit-aware, resumable (per-conv cursor persisted), broadcasts `backfill-progress`. **The pull+upsert engine is built; the missing piece is a proactive/on-demand trigger and a search-API surface.**
- **All search reads DB only** — assistant tools `search_messages` / `get_context` / `list_conversations` (`assistant/loop.ts`) over FTS5 (`search.ts`, `messages_fts` on `messages.body`). Zero local hits ⇒ "nothing in synced history"; never a live upstream query.
- **Cmd+K searches nav actions only** — `chat/src/components/command-palette.tsx` fuzzy-filters registered actions, not messages. No message-search UI exists.
- **Provider seam has no search** — `apps/chat-server/src/providers/provider.ts`: only `fetchHistory` / `listConversations`. Needs a `searchMessages`.
- **In-page executor exists** — `notificationCenter.runInTeamsPage(script)` runs arbitrary authenticated in-page fetches (CA-proof), consumed via `/internal/teams/*` in `web/server.mjs`. The substrate call rides this unchanged.

## Live-probe findings (keeper tab `100.85.206.8:9222`)

- The Teams tab caches a `substrate.office.com/search` MSAL token (`substratesearch-internal.readwrite`) in `localStorage` — no new mint chain required; read it in-page like the existing skypetoken/graph scripts.
- `POST https://substrate.office.com/search/api/v2/query` with headers `Authorization: Bearer <tok>`, `X-AnchorMailbox: <upn>`, `X-RoutingParameter-SessionKey: <upn>`, `client-request-id: <cvid>` and body `{ EntityRequests:[{ EntityType:"Message", ContentSources:["Exchange","Teams"], Query:{QueryString}, From, Size, Fields:[…] }], Cvid, Scenario:{Name:"msai.teams"} }` returns **200 with real `IPM.SkypeTeams.Message` chat hits**. (`ContentSources:["Exchange"]` alone returns only mail `IPM.Note` — the `"Teams"` source is load-bearing.)
- **Hits map cleanly to `chat.db`**: each Teams hit carries `ClientThreadId` = `19:…@thread.tacv2` (our `convId`) and `ClientConversationId` = `19:…@thread.tacv2;messageid=<nativeMsgId>` (our `msgId`), plus `Preview`, `From`, `DateTimeReceived`. Substrate ranking is Microsoft's; date sort available via `SortOrderSource`.

## Approach

**Hybrid: substrate search + hydrate (Decision 1).** Three layers:

1. **Provider search seam** — add `searchMessages(query, opts)` to `ChatProvider`; the Teams impl calls substrate in-page via `runInTeamsPage`, parses hits into `{ convId, msgId, preview, sender, ts }`.
2. **Hydrate pipeline** — for a hit not already in `chat.db`, fetch that conversation's window around `msgId` (existing `fetchHistory` backward-page, reusing the backfill runner's paging) and `upsertMessages`, which also syncs the FTS shadow index. Bounded window, deduped against existing rows.
3. **Consumers** — (a) assistant retrieval tools fall back to substrate on thin/zero local hits; (b) thread jump-to-missing-message hydrates on demand; (c) a new full-screen message-search route.

On-demand only (Decision 2) — no background crawl. Local FTS is always tried first; substrate is the miss/global fallback.

## Decisions (grilled 2026-07-28)

1. **Backend = Hybrid: substrate + hydrate.** Local FTS fast path; substrate live fallback for global reach; hydrate matched windows into `chat.db`.
2. **Trigger = lazy / on-demand only.** Fire on a user search/AI query with thin or zero local hits. No background crawling in this epic.
3. **Consumers = AI assistant search tools + thread jump-to-missing-message + a new full-screen message-search UI.** (Cmd+K becomes an *entry point* to the full-screen search, not the search surface itself.)
4. **Search UI = full-screen takeover, own route** (`/chat/search`): left rail = search box + result items, middle = existing `thread-view` scrolled+flashed to the hit, AI column hidden. Entered by Cmd+K "Search messages" **and** a search icon at the top of the AI-assistant left rail. Esc/back returns to chat.
5. **v1 search capabilities (all in):** typed KQL filters (`from:`/`in:`/`after:`/`before:`/`has:`/`mentions:me`), Relevance⇄Recent sort toggle, scope chips (All / DMs / Groups / folder-label via existing `list_scopes`), background hydrate-on-render.
6. **UI must be polished** via the `ui-ux-pro-max` design skill (not default-looking).
7. **QE workflow required** — a senior-QE-style workstream that authors explicit test cases + runs end-to-end (per `docs/conventions/e2e-verification.md` + `regression` skill), on top of unit/typecheck/lint.
8. **Scope = Teams-only.** Slack global search out-of-scope; contract stays service-agnostic for later. Web/BFF only.
9. **Substrate token** is read from the Teams tab cache in-page; on 401/stale, fall back to `msal.acquireTokenSilent` for the substrate scope in the same script (mirrors existing cred re-mint). No token on disk.

## Workstreams

Each sized for ~one session. Letters are dependency labels, not necessarily order.

- **A — Substrate search seam (server, infra).** `core/teams-substrate.js` pure builder (request body + header shape + hit→`{convId,msgId,preview,sender,ts}` parser, TDD). `/internal/teams/search` in `web/server.mjs` running the in-page substrate fetch via `runInTeamsPage` (token read + silent-acquire fallback, 401/429 → typed error). Add `searchMessages` to `ChatProvider` + `TeamsProvider` (HTTP client of the internal seam) + `MockProvider` (fixture hits). No consumer yet.
- **B — Hydrate pipeline (server).** Pure planner `apps/chat-server/src/hydrate-plan.ts` (given a hit + what's in DB, decide the fetch window / skip if present). Effectful `hydrate.ts` reusing `fetchHistory` backward-paging + `upsertMessages` (FTS synced). Single-flight per conv, bounded pages, dedup. Unit + integration tests.
- **C — Assistant tool fallback (server).** In `assistant/loop.ts`, when `search_messages` / `list_conversations` return thin/zero local hits, call `provider.searchMessages`, hydrate (WS-B), then re-query local FTS so the model sees real rows with citations. Rate-limited, honest on provider failure (degrade to local-only, never crash the turn).
- **D — Search BFF contract + route (server).** `POST /api/chat/search` (service-agnostic, `service` discriminator): parse KQL filters (pure `search-query.ts` parser, TDD), call substrate, hydrate-on-render (background, capped concurrency), return ranked hit rows (Relevance|Recent) + scope handling via `listScopes`. WS or HTTP for background-hydrate progress if needed.
- **E — Full-screen search UI (FE).** `/chat/search` route + `search-view.tsx` (left rail search box + result list; middle reuses `thread-view` with `aroundMsgId` + flash; AI column hidden). Client `chat-client.ts` `searchMessages`. Entry points: Cmd+K action + AI-rail search icon. Keyboard nav (j/k/Enter/Esc), recent-searches, four-state coverage. Phone-responsive stacked variant (search→results→thread→back) — wide-first, phone last.
- **F — Filters / sort / scope-chips UI (FE).** Typed-filter chips + parser feedback, Relevance⇄Recent toggle, scope chips (All/DMs/Groups/folder-label). Built on shadcn.
- **G — UI polish pass.** Run `ui-ux-pro-max` design skill over the search surface; visual verification (light/dark, wide+phone) via `/cdp` + chrome-devtools MCP (or `agent-browser` fallback), zai-vision for the no-vision case.
- **H — QE workflow.** Author explicit search test cases (`docs/testing/chat-qa.md` additions), extend the mock provider with search fixtures, run the `regression` skill end-to-end against the mock stack. Covers: empty DB → substrate populates; filter parsing; hydrate idempotency; jump-to-missing; sort modes; scope chips; rate-limit/401 degradation.
- **I — Bug sweep (last).** Cross-cutting fixes, dead-code/orphan cleanup, `docs-revise` over the changed surfaces, ADR (extend ADR-0021 assistant / a new ADR for the substrate search data-plane).

### Dependency / parallelism

| Workstream | Depends on | Can parallelize with |
|---|---|---|
| A substrate seam | — | (start first) |
| B hydrate pipeline | A (hit shape) | E/F FE scaffold |
| C assistant fallback | A, B | D |
| D search route | A, B | C |
| E search UI | D (contract) | F |
| F filters/sort/scope | D, E | — |
| G polish | E, F | — |
| H QE | C, D, E, F | G |
| I bug sweep | all | — |

Critical path: A → B → D → E → F → G → H → I. C runs alongside D. FE scaffolding (E/F skeleton against the mock provider) can start once D's contract shape is fixed.

## Acceptance criteria

- [ ] `ChatProvider.searchMessages` exists; Teams impl returns real substrate hits mapped to `{convId,msgId,preview,sender,ts}`; Mock returns fixtures. Unit-tested (pure builder + parser).
- [ ] `/internal/teams/search` runs the in-page substrate query CA-proof; 401 triggers silent re-acquire; 429/error is a typed `ProviderError`.
- [ ] Hydrate pipeline upserts a missing hit's conversation window into `chat.db`, FTS-indexed, idempotent (re-run adds nothing), single-flight per conv. Tested.
- [ ] Assistant `search_messages` returns results for a term that exists upstream but was **not** in `chat.db` before the query (empty-DB → substrate → hydrate → local FTS → cited answer). Verified live against the probe host.
- [ ] `POST /api/chat/search` parses KQL filters (`from/in/after/before/has/mentions:me`), honors Relevance⇄Recent + scope chips, returns ranked rows. Parser unit-tested.
- [ ] Full-screen `/chat/search`: type a query → results in left rail → click → middle thread scrolls to + flashes the exact message; missing message hydrates on open. Cmd+K and the AI-rail search icon both open it. Esc returns.
- [ ] Four-state coverage (loading / empty / error+retry / populated) on the search surface; keyboard nav (j/k/Enter/Esc); recent searches.
- [ ] UI polished via `ui-ux-pro-max`; visual pass light+dark, wide (+phone if it lands) with screenshots in the Linear evidence.
- [ ] QE: new search cases in `docs/testing/chat-qa.md`; `regression` skill run green against the mock stack; rate-limit/401 degradation verified.
- [ ] `pnpm test` + `pnpm test:e2e` + `pnpm typecheck` + `pnpm check:changed` all green.
- [ ] Docs revised; ADR recorded for the substrate search data-plane.

## Risks

- **R1 — substrate token expiry / silent-acquire.** Cached token can be stale; must fall back to `msal.acquireTokenSilent` in-page. Mitigation: 401→acquire→retry once in the in-page script; typed error if acquire fails. (Live-probed token worked; expiry path needs a test.)
- **R2 — substrate ranking/shape drift.** Microsoft owns ranking and the response schema; a shape change breaks the parser. Mitigation: defensive parse, keep the pure parser well-tested, log-and-degrade to local FTS on parse failure.
- **R3 — hydrate cost / rate limits.** Background hydrate-on-render can fan out many `fetchHistory` calls through the single in-page keeper tab (same funnel as the sweep). Mitigation: cap concurrency, single-flight per conv, bounded window, reuse the sweep's 429 discipline; hydrate visible hits first.
- **R4 — id mapping edge cases.** Grid/channel threads, deleted messages, or hits whose `messageid` no longer exists in msg-service. Mitigation: hydrate is best-effort; a hit that can't hydrate still renders from its substrate preview (jump shows `missing`).
- **R5 — E2E/media confidentiality.** Substrate previews ride the `/internal` seam like other Teams calls; no new disk persistence of tokens. Consistent with existing E2E tradeoffs.
- **R6 — phone layout scope creep.** Full-screen search on the stacked phone shell is real extra FE. Mitigation: wide-first; phone is the last FE increment and may slip to a follow-up without blocking the epic.

## Out of scope

- Slack (or any non-Teams) global search — contract stays service-agnostic, but no Slack wiring here.
- Background/eager crawling of history into `chat.db`.
- Electron-native Teams creds (structurally stubbed; the `/chat` Electron shell inherits search through the web server).
- Full adaptive-card / attachment search beyond message body text.
- Replacing the existing manual Settings backfill (kept as-is).

## Related epics

- **PSN-114 (Expose chats as MCP server)** — strong synergy, low conflict if sequenced. PSN-114 exposes `chat.db` queries as MCP tools for Claude Code; without PSN-115 those tools only see the synced DB subset. PSN-115's `provider.searchMessages` + hydrate + `/api/chat/search` are the **data plane PSN-114 should reuse** so an MCP `search_messages` reaches all Teams history, not just what's local. **Land PSN-115's search seam (WS-A/B/D) before PSN-114 wires its MCP tools.** Shared files to coordinate if the two run in parallel: `assistant/loop.ts` tool defs, `search.ts`, `contract.ts`, `routes.ts` — same-file edits are the only real conflict risk.

- **E2E test plan** — the deep QE artifact for this epic lives in [`docs/testing/PSN-115-search-e2e-plan.md`](../testing/PSN-115-search-e2e-plan.md).
