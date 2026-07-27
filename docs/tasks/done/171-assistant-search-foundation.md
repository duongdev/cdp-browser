# 171 — assistant search foundation: folded FTS5 + retrieval tool data layer

- **Status:** done
- **Mode:** AFK
- **Estimate:** 1d
- **Depends on:** none
- **Blocks:** t173

## Goal

`chat.db` becomes searchable: an FTS5 external-content index over a pre-folded plain-text shadow of `messages.body`, plus the pure query functions the assistant's tools will call — `searchMessages`, `getContextWindow`, `listConversationsByQuery`, `resolvePerson`. After this task, a Vietnamese ASCII query (`"duong da nang"`) finds `"Đường Đà Nẵng"` messages, filtered by sender/conversation/time range.

## Why now

Retrieval is the assistant's spine (ADR-0021 decision 2) — t173's agent loop is blocked on these functions existing and being trustworthy. It's also the only piece with verified sharp edges (đ does not fold in FTS5's `remove_diacritics=2`), so it must be TDD'd first, standalone.

## Acceptance criteria

- [ ] A fold function in `apps/chat-server` matches the repo fold semantics (NFD strip marks + đ→d + lowercase), TS-native.
- [ ] An HTML-strip helper reduces `messages.body` (rendered HTML) to plain text for indexing (tags dropped, entities decoded, media degraded to nothing or alt text).
- [ ] `migrate()` creates the FTS5 table (external-content or contentless keyed by rowid mapping to `messages`) + keeps it in sync with every `upsertMessages` write path (insert/update/delete/tombstone).
- [ ] Boot backfill indexes all existing rows in a transaction, idempotent (re-boot does not re-index or duplicate).
- [ ] `searchMessages({query, sender?, convId?, after?, before?, limit})` — FTS MATCH on folded query + SQL filters, returns `{service, convId, msgId, senderName, ts, snippet}` ordered by relevance/recency; folded at query time too.
- [ ] `getContextWindow({convId, aroundMsgId? | beforeTs?, limit})` — returns a message window from the DB (no provider calls).
- [ ] `resolvePerson({name})` — fold-matched lookup over the `users` table returning `{id, displayName}` candidates.
- [ ] Vietnamese cases green: ASCII query hits diacritic text, diacritic query hits its own text, `đ`-words found from `d`-queries.

## Test plan

### Layer 1 — Pure logic (TDD)

- [ ] fold — Vietnamese (đ/Đ, stacked tones, horns), idempotence, non-Latin passthrough
- [ ] html-strip — tags, entities, mention spans, media elements
- [ ] search/window/person functions — vitest against `:memory:` better-sqlite3 (same style as `store.test.ts`): filters, ordering, limits, tombstoned/deleted exclusion, FTS-sync after upsert/edit/delete
- [ ] backfill idempotence — migrate twice, index count stable

### Layer 2 — Manual smoke (CDP/IPC)

n/a — DB layer only.

### Layer 3 — Visual review

n/a — no UI.

## Design notes

- **Contracts changed:** none public; new internal search module in `apps/chat-server/src`.
- **New modules:** `search.ts` (fold + strip + query functions), schema additions in `store.ts` `migrate()`.
- **New ADR needed?** no — ADR-0021 covers it.

Keep all writes funneled through `upsertMessages` (ADR-0021 consequence: trigger drift corrupts external-content FTS). Prefer explicit index maintenance inside `upsertMessages` over SQL triggers if it reads clearer — but one owner either way.

## Out of scope

- LLM anything (t172/t173). Tools here are plain functions, not AI SDK tool defs.
- Japanese/CJK trigram index (grilled: VN+EN only for v1).
- Embeddings (deferred per ADR-0021).
- The legacy `core/teams-store.js` `messages_fts` stub — untouched, it belongs to the deprecated web-teams.db.

## Definition of Done

- [ ] Layer 1 tests written and green
- [ ] `pnpm check:changed` clean, `pnpm typecheck` clean, `pnpm test` green
- [ ] CLAUDE.md updated (apps/chat-server entry)
- [ ] Task closed: status → done, file moved to `docs/tasks/done/`, tNNN in commit
