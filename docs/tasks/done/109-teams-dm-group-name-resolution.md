# 109 — teams DM / group-DM name resolution (real names, not "Direct message")

- **Status:** done
- **Mode:** HITL
- **Depends on:** t105–t108 (creds, store, conversations, thread)
- **Blocks:** UI polish (labels must be right first)

## Goal

Conversation list + thread header show **real names** for DMs (`@person`) and group-DMs
(`@a, b, +N`) instead of the "Direct message" / "Group chat" fallback. Names resolve via
Microsoft Graph (proven path below), cached so it's a one-time lookup per person. User
feedback #2 after trying t108 — highest priority (can't triage without knowing who).

## Proven data path (probed live 2026-07-21 — use verbatim)

- Member names are **NOT** in the conversation object or `GET /v1/threads/{id}` (that gives
  member MRIs `8:orgid:{oid}` only, zero name fields). Names need a **profile lookup by MRI**.
- **1:1 DM id encodes both MRIs**: `19:{mriA}_{mriB}@unq.gbl.spaces` → the other member's MRI
  is derivable from the id — **no thread fetch** for DMs.
- **Group-DM** (`19:…@thread.v2`, no topic): id doesn't encode members → fetch the roster via
  `GET {chatServiceBase}/v1/threads/{convId}?view=msnp24Equivalent` → `members[].id` (MRIs).
- **Resolve MRI → name via Graph** (Teams graph bearer, `user.readbasic.all` scope, in-page):
  `POST https://graph.microsoft.com/v1.0/directoryObjects/getByIds` body `{ ids:[oid,…],
  types:["user"] }` → 200 `{ value:[{ id, displayName }] }` (**verified**; batch resolves all
  members in one call). `oid = mri.replace("8:orgid:","")`. Self MRI = `8:orgid:{creds.userId}`.
- All calls run **in-page** (CA-proof) via `runInTeamsPage`; graph.microsoft.com is CORS-OK
  from the teams origin.

## Scope

- **`core/teams-names.js`** (pure, TDD): `otherMrisFromId(convId, selfMri)` — for a
  `@unq.gbl.spaces` id, split `19:{a}_{b}` on `_`, drop self, return the other MRI(s); for a
  `@thread.v2` id return `[]` (roster comes from the members fetch). `oidFromMri(mri)`.
  `composeTitle({ kind, topic, memberNames, selfName })` — topic if set; else DM → the one
  other name; group-DM → `"a, b, +N"` (cap ~3 names + overflow count); empty → "Direct
  message"/"Group chat" fallback (never crash on a missing name).
- **`core/teams-store.js`** — a `users` table (`mri` PK, `display_name`, `updated_at`) +
  `upsertUsers` / `getUsers(mris)`; TDD. The resolved-name cache (resolve once, reuse).
- **Server (`web/server.mjs`)** — extend the `/api/teams/conversations` flow: for each
  topic-less DM/group-DM, gather member MRIs (DM: derive from id; group-DM: in-page thread
  fetch), diff against the `users` cache, resolve the **misses** in ONE in-page Graph
  `getByIds` batch, `upsertUsers`, then `composeTitle` per conversation and return it as a
  `title` field on each conversation (topic'd convs keep their topic as title). Best-effort:
  a Graph failure degrades to the old fallback label, never fails the list.
- **UI** — `chat/src/lib/conversation-view.ts` `conversationLabel` prefers `conv.title` (then
  topic, then fallback); `thread-view.tsx` header uses the same title. `teams-client.ts`
  `TeamsConversation` gains `title?: string`.

## Acceptance criteria

- [ ] DM rows show the other person's name; group-DM rows show `a, b, +N`; topic'd chats
      keep their topic. Missing name → graceful fallback (no crash, no blank).
- [ ] Names resolve via the in-page Graph `getByIds` batch (one call for all misses) and are
      cached in `users` (second load does zero Graph calls for known people).
- [ ] `otherMrisFromId` + `composeTitle` + store cache are TDD-covered.
- [ ] A Graph failure degrades to the fallback label; the conversation list still returns.
- [ ] Thread header shows the resolved title too.

## Test plan

- **Layer 1 (TDD):** `teams-names` (id parsing for `@unq`/`@thread.v2`, self-drop, title
  composition + overflow + fallbacks); `teams-store` users upsert/get.
- **Layer 2 (smoke, live keeper):** `GET /api/teams/conversations` → DM/group rows carry real
  `title`s; second call makes no Graph request (cache hit — check server log/timing).
- **Layer 3 (visual):** screenshot the list with real DM/group names + a thread header.

## Design notes

- Mirrors Slack's name story (`slackGroupLabel`), but Teams resolves via Graph not a workspace
  users.list. Cache is load-bearing — resolving every DM every list-load would hammer Graph.
- Covered by ADR-0018; no new ADR. (If Graph rate-limits at scale, add a TTL later — YAGNI now.)

## Out of scope

- Avatars/photos (Graph `/photo` — later, part of UI polish). Presence. Rich-HTML render
  (separate task). Instant-switch/scroll-persist (user feedback #4, next task).

## Definition of Done

- [ ] Layer 1 green; Layer 2 smoke (live); Layer 3 shot.
- [ ] `pnpm check`(touched)/`typecheck`/`test`/`node --check web/server.mjs`/`chat:build`/`/` build unchanged.
- [ ] CLAUDE.md updated (name resolution + `users` cache). No AI attribution / console debris.
- [ ] Task → done, moved to `done/`, `t109` in commit.

## Notes

- Worktree: docs on main, code on feature branch (2-commit ship); never `git add -A`;
  `--no-verify` (rtk breaks pre-commit). Graph batch + DM-id-derivation PROVEN live.
