# PSN-115 — Deep E2E Test Plan (proactive backfilling + global message search)

Companion to [`docs/plans/PSN-115-proactive-backfilling.md`](../plans/PSN-115-proactive-backfilling.md). This is the senior-QE artifact for workstream **H**. It obeys the standing contract in [`e2e-verification.md`](../conventions/e2e-verification.md): regression runs in **subagents** (orchestrator gets verdicts, not evidence), the UI is driven with **real input events**, every variable-content case runs **long and short**, and each surface covers the **four states** in **both themes** + a **390×844** viewport.

Cases here are **added to** [`docs/testing/chat-qa.md`](chat-qa.md), never rewritten. Case IDs below use the `SB-` (search + backfill) prefix so they slot into the existing checklist without renumbering.

## Test layers (which skill proves what)

| Layer | Skill / tool | Proves |
|---|---|---|
| Pure logic | `tdd` (Vitest) | Query parser, hit→id mapper, hydrate planner, stop conditions — red-green-refactor, no I/O |
| Server integration | Vitest + `MockProvider` | search route, hydrate upsert idempotency, assistant fallback, FTS sync |
| Hermetic E2E | `pnpm test:e2e` (fake CDP host) | BFF+web wired end to end, no tenant |
| UI E2E | `regression` + `webapp-testing` + `/cdp` / `agent-browser` | The surface a human uses, real events, four states, long/short |
| Visual polish | `pixel-perfect-verify` + `zai-vision` (no-vision fallback) | Light/dark, wide+phone, no overflow/clipping |
| Live smoke | probe host `100.85.206.8:9222` | Substrate actually returns + hydrates real Teams data |

## Stacks

- **Unit/integration/hermetic:** `pnpm test`, `pnpm test:e2e` — **Node 24** (`nvm use 24`; `better-sqlite3` ABI).
- **UI E2E:** the mock stack — `pnpm chat:mock` (BFF :7910 + web :7900, `.mock-data/`). Concurrent QE areas MUST isolate: `MOCK_DIR=… WEB_PORT=… BFF_PORT=… pnpm chat:mock`.
- **Mock provider needs a search fixture (build task, WS-A/H):** extend `apps/chat-server/src/providers/mock-provider.ts` with a `searchMessages` that returns hits, including **hits for messages NOT seeded into the DB** — that gap is the whole point of the epic. Add a `POST /api/chat/mock/say` style helper if needed to seed "upstream-only" messages.
- **Live smoke:** the probe host keeper tab (self-chat only, read-only, no mutations to other threads).

## Dispatch model

Orchestrator boots one isolated stack per area, spawns one subagent per **area** below with that area's case IDs, collects `PASS/FAIL/BLOCKED` + one-line symptoms only. Screenshots to `/tmp/<run-id>/`. Re-runs after a fix are **scoped** to the failed IDs + same-component cases; one full sweep at the end.

Areas: **A** search data-plane (server) · **B** hydrate · **C** assistant fallback · **D** search route/contract · **E** search UI · **F** filters/sort/scope · **G** visual · **L** live smoke.

---

## Area A — Substrate search seam (server, unit + integration)

- **SB-A1** (unit) Request builder: given a query + opts, body has `EntityType:"Message"`, `ContentSources:["Exchange","Teams"]`, correct `From/Size`, `Scenario:"msai.teams"`. Headers include `X-AnchorMailbox` + `X-RoutingParameter-SessionKey` + `client-request-id`.
- **SB-A2** (unit) Hit parser: a `IPM.SkypeTeams.Message` result → `{convId: ClientThreadId, msgId: <from ClientConversationId messageid=…>, preview, sender, ts}`. `Exchange`/`IPM.Note` mail hits are dropped (Teams-only).
- **SB-A3** (unit) Parser is defensive: missing `ClientThreadId`, absent `messageid=`, malformed `From`, empty `Results` → skipped rows, never a throw (R2).
- **SB-A4** (unit) `searchMessages` maps a 401 → typed `ProviderError("auth")`, 429 → `ProviderError("rate_limited")`.
- **SB-A5** (integration) `MockProvider.searchMessages` returns fixtures through the provider seam; `TeamsProvider` calls `/internal/teams/search`.
- **SB-A6** (integration) `/internal/teams/search` requires the `x-internal-secret`; 403 without it.

## Area B — Hydrate pipeline (server, unit + integration)

- **SB-B1** (unit) hydrate planner: hit already in DB → **skip** (no fetch). Hit missing → plan a bounded window around `msgId`.
- **SB-B2** (integration) Missing hit → hydrate fetches the conv window, `upsertMessages` writes rows, FTS shadow index gains the term. **A second identical hydrate adds zero rows** (idempotent).
- **SB-B3** (integration) Single-flight: two concurrent hydrates of the same conv issue one fetch pass, not two.
- **SB-B4** (integration) Page ceiling honored; a conv whose msgId is never reached stops at the cap and logs, doesn't loop (R3).
- **SB-B5** (integration) A hit that can't hydrate (msgId gone upstream) leaves the DB untouched and is still returned from its substrate preview (R4).

## Area C — Assistant fallback (server, integration + live)

- **SB-C1** (integration) `search_messages` with a term **only upstream** (seed the mock so the DB lacks it, provider has it): returns 0 local → substrate → hydrate → re-query local FTS → non-empty rows with valid `[msg:convId:msgId]` citations.
- **SB-C2** (integration) Term present locally → **no** substrate call (fast path, assert provider.searchMessages not invoked).
- **SB-C3** (integration) Provider 429/401 during fallback → the tool degrades to local-only results, the assistant turn still completes (never crashes). Honest "couldn't reach upstream" note.
- **SB-C4** (live, probe host) Ask the assistant for a phrase you know exists in a self-chat but is NOT yet in a fresh `chat.db`; verify it surfaces + cites after hydrate. `PASS`/`FAIL` only.

## Area D — Search route + query parser (server)

- **SB-D1** (unit) KQL parser: `from:@ann after:2026-07-01 has:link foo` → `{text:"foo", from:"ann", after:<ts>, has:["link"]}`. Unparseable operator → treated as literal text, never dropped silently.
- **SB-D2** (unit) `mentions:me` and `in:"Some Topic"` (quoted multi-word) parse correctly.
- **SB-D3** (integration) `POST /api/chat/search` returns ranked rows; `sort=recent` orders by ts desc, `sort=relevance` preserves substrate order.
- **SB-D4** (integration) scope chip `in:folder` resolves via `listScopes` to convIds; empty scope → empty result (not "unfiltered").
- **SB-D5** (integration) background hydrate-on-render is capped-concurrency and does not block the response (rows return before hydrate finishes).

## Area E — Search UI (mock stack, real events)

Drive with `page.*` / CDP `Input.*`. Assert on visible text + geometry.

- **SB-E1** Cmd+K → "Search messages" opens `/chat/search` (route changes, AI column hidden). **Real key event**, not a synthetic dispatch.
- **SB-E2** The AI-rail search icon opens the same route.
- **SB-E3** Type a query → left-rail results populate (debounced). Click a result → middle `thread-view` scrolls to + **flashes** the exact message.
- **SB-E4** Result for a message not in DB → clicking hydrates then renders the thread (not a permanent `missing`).
- **SB-E5** Keyboard nav: `j`/`k` move selection, `Enter` opens, `Esc` returns to chat.
- **SB-E6** Four states: loading skeleton, empty ("no messages"), error+Retry (kill BFF mid-query), populated.
- **SB-E7** Recent searches persist within the session and re-run on click.
- **SB-E8** (long/short) result rows with: 1-char query vs 300-char query; a hit whose conv topic is 200 chars mixed-script; a hit body of 4000 chars one unbroken token; Vietnamese + CJK snippet — no overflow, snippet highlight lands on the match.
- **SB-E9** (phone 390×844, if phone lands) stacked search→results→thread→back; back button returns to results, not chat.
- **SB-E10** (both themes) light + dark, no contrast/clipping regressions.

## Area F — Filters / sort / scope (mock stack, real events)

- **SB-F1** Typed filter chips render from the query and are removable; removing re-runs the search.
- **SB-F2** Relevance⇄Recent toggle reorders the visible list (assert first-row identity changes).
- **SB-F3** Scope chips All/DMs/Groups/folder-label filter the result set; folder-label sourced from `list_scopes` matches the assistant's scopes.
- **SB-F4** (long/short) 0 results, 1 result, results past one page (infinite-scroll / load-more), 12-filter query.

## Area G — Visual polish (pixel-perfect-verify + zai-vision)

- **SB-G1** `ui-ux-pro-max` output applied; the search surface is not default-looking (spacing, empty state, focus ring, result-row rhythm). Screenshot review light+dark, wide+phone.
- **SB-G2** No-vision fallback: screenshot to file → `zai-vision analyze_image` with enumerated questions (name each element + expected colour/state), never "does this look right".

## Area L — Live smoke (probe host, self-chat only)

- **SB-L1** `/internal/teams/search` against the real keeper tab returns ≥1 `IPM.SkypeTeams.Message` hit for a common term; hit maps to a real `convId`.
- **SB-L2** Hydrate one missing self-chat message end to end; confirm it appears in `chat.db` + FTS.
- **SB-L3** Token-stale path: force a 401 (expired cached token) → in-page silent-acquire → retry succeeds (R1). If the acquire can't be forced, mark `PASS (synthetic)` with a unit test standing in.

---

## Exit criteria

- All `SB-*` unit + integration cases green in `pnpm test`; `pnpm test:e2e` green.
- One full `regression` sweep (subagent-dispatched) with every UI area `PASS` or a filed defect; defects that are data-loss / false-PASS class are fix-now.
- Live smoke L1–L2 `PASS` against the probe host.
- Visual pass signed off light+dark (+phone if in scope).
- New rows landed in `chat-qa.md` with the run stamp.

## Known local ceilings (state them, don't skip)

- Real Teams cred minting, the keeper tab, and cross-user threads are **not** reproducible on the mock stack — those are live-smoke only, self-chat only.
- Web Push, OS-toast draw, and real send/edit round-trips stay out of this plan (unchanged by PSN-115).
- Substrate ranking is Microsoft's — assert on *presence + mapping*, not exact rank order.
