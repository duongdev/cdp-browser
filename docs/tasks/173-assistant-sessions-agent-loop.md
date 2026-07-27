# 173 — assistant backend: sessions store, agent loop, citation validation, stream route

- **Status:** ready
- **Mode:** AFK
- **Estimate:** 1d
- **Depends on:** t171, t172
- **Blocks:** t174

## Goal

The assistant's whole backend: `ai_sessions`/`ai_messages` tables in `chat.db`, a step-capped agent loop wiring t171's search functions as AI SDK zod tools, server-side citation validation, session CRUD + a `POST /api/chat/assistant/:sessionId` route streaming a UI message stream from Hono, title auto-generation, and summarize-and-compact for long sessions. After this task, `curl` can hold a full cited conversation with the assistant; no FE yet.

## Why now

Everything user-visible (t174–t176) renders what this task produces. Isolating it keeps the FE task purely presentational.

## Acceptance criteria

- [ ] Schema: `ai_sessions(id, title, model, created_at, updated_at, summary, summary_upto_idx, total_tokens, context_refs JSON)` + `ai_messages(id, session_id, idx, role, parts JSON, metadata JSON, sdk_major, created_at)` — one row per UIMessage, added via the existing `migrate()` style.
- [ ] Session CRUD routes (list/create/rename/delete) on a Hono sub-app mounted at `/api/chat/assistant` in `index.ts`; `web/server.mjs` untouched (path-prefix proxy already forwards).
- [ ] Chat route: loads session UIMessages (tolerant validation — unknown parts dropped, never a crash), runs the agent loop (`streamText` + tools + `stopWhen` step cap ~8), returns `toUIMessageStreamResponse()`; `consumeStream()` un-awaited so a dropped tab still persists the finished message in `onFinish`.
- [ ] Tools: `search_messages`, `get_context`, `list_conversations`, `resolve_person` — thin zod wrappers over t171 functions, compact token-efficient results, every row stamped `(convId, msgId)`.
- [ ] Citations: system prompt mandates inline markers `[msg:{convId}:{msgId}]`; server tracks ids surfaced by tool calls per session, strips markers not in that set, and stores validated citations on the assistant message row.
- [ ] Context refs ("ask AI about this"): attach endpoint appends `{service, convId, msgId?, title, deepLink}` to `context_refs`, injects referenced content once as a message part; every later turn pins only the one-line descriptors into the system prompt.
- [ ] Titles: after first exchange, fire-and-forget `generateText` (≤50 chars, same language as user); failure leaves first-40-chars fallback.
- [ ] Compaction: when projected prompt exceeds ~40K tokens (chars/4 estimate, reconciled by returned `usage` accumulated into `total_tokens`), summarize older messages into `summary` + advance `summary_upto_idx`; stored rows never deleted.
- [ ] All LLM-dependent tests run against a mock `LanguageModel` (t172 pattern) — deterministic, no network.

## Test plan

### Layer 1 — Pure logic (TDD)

- [ ] session store round-trip (`:memory:` DB): CRUD, UIMessage persist/load, tolerant validation on junk parts, `sdk_major` stamped
- [ ] citation validator — valid kept, hallucinated stripped, malformed degrade to plain text
- [ ] compaction policy — threshold math, watermark advance, sent-vs-stored separation
- [ ] agent loop with mock model — tool call round-trip, step cap enforced, onFinish persistence

### Layer 2 — Manual smoke (CDP/IPC)

- [ ] One live curl session through 9router: ask about a real message, verify streamed answer + valid citation ids + session survives server restart

### Layer 3 — Visual review

n/a — no UI.

## Design notes

- **Contracts changed:** `/api/chat/*` contract grows an `assistant` section (session shapes, citation shape) in `contract.ts`.
- **New modules:** `assistant/` dir in `apps/chat-server/src` (routes, session store, loop, citations, compact).
- **New ADR needed?** no — ADR-0021 decisions 3–5.

Reuse the `ProviderError`/`statusOf` error contract. Errors from the LLM (429/timeout/unconfigured) must reach the FE as typed codes — honest failure like `slack-reply.ts` precedent, no silent retry loops.

## Out of scope

- All FE (t174), scroll-to-message serving beyond `get_context` (t175 reuses it), quick actions (t176).
- Multi-user/auth — single-user by architecture.
- Resumable streams (rejected in ADR-0021).

## Definition of Done

- [ ] Layer 1 tests green; live smoke done
- [ ] `pnpm check:changed` clean, `pnpm typecheck` clean, `pnpm test` + `pnpm test:e2e` green
- [ ] CLAUDE.md updated (BFF section)
- [ ] Task closed: status → done, file moved to `docs/tasks/done/`, tNNN in commit
