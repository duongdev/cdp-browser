# 112 — teams chat pagination: syncState/backwardLink cursor (thread scroll-back + list load-more)

- **Status:** done
- **Mode:** HITL
- **Depends on:** t107 (thread), t109 (list)
- **Blocks:** UI polish

## Goal

Thread scroll-back actually loads older messages, and the conversation list loads more
past the first page — both via Teams' real cursor. User feedback #1. t107's thread
scroll-back used `startTime=<ts>` which is the WRONG mechanism (silently no-ops / re-returns
the same page); replace it with the real cursor.

## PROVEN mechanism (probed live 2026-07-21 — use verbatim)

- Both `GET …/conversations` and `GET …/conversations/{id}/messages` responses carry
  `_metadata.backwardLink` — a **full URL** with an opaque `syncState` token (and a
  `forwardLink`/`syncState` sibling). To page OLDER, **fetch that `backwardLink` URL
  directly**. `backwardLink` empty/absent → no more pages.
- `startTime=<ts>` does NOT page older reliably — drop it. First page: `?pageSize=N&startTime=1`;
  older pages: the `backwardLink` URL from the previous page's `_metadata`.
- **SECURITY**: `backwardLink` is a URL the SERVER fetches **in-page with the skypetoken**. A
  client must not be able to make the server fetch an arbitrary URL (skypetoken exfiltration /
  SSRF). VALIDATE the cursor `startsWith(chatServiceBase + "/")` and is https before the
  in-page fetch; reject otherwise. (`chatServiceBase` = the tenant's regional host.)

## Scope

- **`core/teams-*` pure helper** — `isValidTeamsCursor(url, chatServiceBase)` (https +
  `startsWith(base + "/")`); TDD. The single gate before any cursor fetch.
- **`web/server.mjs` `POST /api/teams/history`** — accept optional `{ cursor }`. No cursor →
  first page (`?pageSize=30&startTime=1`). Cursor → validate with `isValidTeamsCursor` (reject
  → 400), fetch that URL in-page. Return `{ messages, cursor: _metadata.backwardLink || null }`
  (null = no older). Keep the render + upsert. (Remove the `before`/`startTime` param path.)
- **`web/server.mjs` `POST /api/teams/conversations`** (or keep GET + optional cursor) —
  return `{ conversations, cursor }`; accept `{ cursor }` for the next page (validate + fetch
  the conversations `backwardLink`). Name-resolution enrichment (t109) runs per page.
- **`chat/src/lib/teams-client.ts`** — `fetchHistory(convId, cursor?)` → `{ messages, cursor }`;
  `fetchConversations(cursor?)` → `{ conversations, cursor }`.
- **`chat/src/components/thread-view.tsx`** — hold the older-cursor; scroll-to-top with a
  non-null cursor loads the older page + prepends (keep the existing scroll-anchor so the
  viewport doesn't jump); when cursor is null, stop (no more). A subtle "loading older"
  affordance.
- **`chat/src/components/conversation-list.tsx`** — hold the list cursor; a "load more" at the
  bottom (button or on-scroll) fetches the next page + appends; stop when cursor null. Dedup by
  id on append.

## Acceptance criteria

- [ ] Scrolling a thread to the top loads OLDER messages (verified they're older, not a
      repeat of the same page) until the cursor is exhausted; no viewport jump on prepend.
- [ ] The conversation list loads a second (and further) page past the first ~30/50 and
      appends without duplicates.
- [ ] A cursor not matching `chatServiceBase` is rejected (400) — no in-page fetch of an
      arbitrary URL. TDD.
- [ ] `cursor: null` on the last page stops further loads (no infinite spinner).

## Test plan

- **Layer 1 (TDD):** `isValidTeamsCursor` (accept base-prefixed https, reject other-host /
  non-https / empty); any pure prepend-dedup helper.
- **Layer 2 (smoke, live keeper):** thread history → `cursor` present; POST with that cursor →
  OLDER messages (older ts than page 1); conversations → cursor → page 2 distinct ids. (The
  orchestrator will live-verify the backwardLink actually returns older content.)
- **Layer 3 (visual):** scroll a stubbed thread to top → older page prepends, no jump; list
  "load more" appends.

## Design notes

- The cursor is opaque (a full MS URL) — pass it through client↔server as a string, never
  parse/trust it beyond the host-prefix gate. Prefer whitelisting the host over reconstructing.
- Replaces t107's `before`/`startTime` older-page path. Covered by ADR-0018.

## Out of scope

- Realtime new-message arrival (t-sweep). Virtualization (react-virtuoso — only if a long
  thread janks). UI polish.

## Definition of Done

- [ ] Layer 1 green (incl. the cursor-validation reject case); Layer 2 live; Layer 3 shots.
- [ ] `pnpm check`(touched)/`typecheck`/`test`/`node --check web/server.mjs`/`chat:build`/`/` build unchanged.
- [ ] CLAUDE.md updated (cursor pagination + the security gate). No AI attribution / console debris.
- [ ] Task → done, moved to `done/`, `t112` in commit.

## Notes

- Worktree: docs on main, code on feature branch (2-commit ship); never `git add -A`;
  `--no-verify` (rtk breaks pre-commit). backwardLink/syncState cursor PROVEN live; ts fields
  render fine already (t107). Guard the cursor host — skypetoken rides the in-page fetch.
