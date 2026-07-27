# PSN-103 — [chat] DM sometimes shows "Direct message" instead of actual name (plan)

Status: grilled — decisions resolved · plan-only · 2026-07-27
Issue: https://linear.app/withdustin/issue/PSN-103

A topic-less DM/group-DM has no server-side name of its own — the title is *composed* from resolved member display names (`core/teams-names.js` `composeTitle`, ADR-0019/t131). When that composed title is missing at render time the UI degrades to the kind label `"Direct message"` / `"Group chat"`. This plan fixes the three distinct paths where the title goes missing.

## Baseline (probed 2026-07-27, code)

### Where the title is produced

- `web/server.mjs:1227` `teamsResolveTitles(cred, convs)` — for each topic-less conversation: derive member MRIs (1:1 → parsed from the conv id; group-DM → in-page roster fetch), resolve MRI→displayName cache-first (`teamsGetUsers`) and Graph-batch the misses (`resolveTeamsNamesInPage`), then `composeTitle(...)`. Resolved names are persisted per-MRI (`teamsUpsertUsers`), the **composed title is not persisted anywhere**.
- `web/server.mjs:1091` — the only caller. `/api/teams/conversations` returns `title` per row.
- `core/teams-names.js:58` — `names.length === 0` → `"Direct message"` / `"Group chat"`.

### Where the title is consumed

- `chat/src/lib/conversation-view.ts:8` `conversationLabel` — `title` → `topic` → kind fallback.
- `chat/src/chat-app.tsx:490` — the ⌘K palette repeats the same fallback chain inline.

### Where the title is LOST (root cause)

The FE no longer talks to `server.mjs` directly; it goes through the chat BFF (`apps/chat-server`, PSN-93).

1. **BFF store drops `title`.** `apps/chat-server/src/store.ts:18` — the `conversations` table has **no `title` column**. `toConversationInput` (`upsert-map.ts`) does not map `c.title`, `upsertConversations` does not write it, `listConversations` (`store.ts:174`) cannot return it.
2. **Every WS frame therefore ships title-less rows.** `conversation-upsert` is broadcast from three places, all reading the store:
   - `sweep.ts:107` — list sweep tick: `rows = changedConversations.map((c) => after.get(c.id) ?? c)`; `after` is `store.listConversations(...)`, so the store row (no title) **wins over** the provider page row (which HAS a title).
   - `sweep.ts:148` `refreshConvRow` — pure store read.
   - `ws-hub.ts:49` — the **initial snapshot on every WS connect/reconnect**, pure store read.
3. **The client merge then clobbers the good title.** `conversation-merge.ts:45` — `for (const c of freshPage) byId.set(c.id, c)` replaces the row wholesale, so a title-less WS row overwrites a previously-resolved title. The label flips to `"Direct message"` and stays until the next HTTP `/api/chat/conversations` fetch.

This matches the reported "sometimes / race": the HTTP list fetch resolves titles correctly, then the WS snapshot (on connect) or the next sweep tick wipes them.

### Two secondary paths

4. **Silent Graph failure.** `web/server.mjs:1135` `resolveTeamsNamesInPage` runs in the keeper tab and returns `{}` on *every* failure — no MSAL access-token key in `localStorage`, non-2xx, or a throw — with **no log and no retry**. `teamsResolveTitles` wraps the whole block in a `try/catch` that only logs `e.message`, so a token-not-yet-present window silently yields `"Direct message"` for a brand-new DM whose member isn't in `teams_users` yet. This is the genuine first-render case; store persistence masks repeats, not the first one.
5. **Deep-link stub.** `chat/src/chat-app.tsx:142` `stubConversation(id)` builds a placeholder from a push deep-link with `kind: "oneOnOne"`, `topic: null`, no `title` — the thread header renders `"Direct message"` until a list tap replaces it. Already acknowledged in a `ponytail:` comment.

## Decisions (grilled 2026-07-27)

1. **Fix depth → persist the title in the BFF store.** Add a `title` column with an `ALTER TABLE` migration (`CREATE TABLE IF NOT EXISTS` will not add it to an existing DB), carry it through `toConversationInput` → `upsertConversations` → `listConversations`. Never overwrite a stored non-empty title with an empty one. Fixes all three WS paths at the source and makes the title survive a transient Graph miss. *Rejected: client-side sticky merge alone* — band-aid at one consumer, leaves the store wrong and makes a group rename show a stale title.
2. **Graph miss → in scope: log + one retry, plus a client-side fallback.** Stop swallowing the reason in `resolveTeamsNamesInPage`; retry the batch once. Additionally, when a conversation has no resolvable title the client derives a provisional label from the thread's known sender names rather than showing the kind label.
3. **Deep-link stub → in scope: hydrate it.** On a deep-link open, look the id up in the already-loaded list first; if absent, fetch the single row / reuse roster-or-history sender names before rendering the header.
4. **Pending state.** When a title is unresolved *and* a resolution is in flight, render a loading state (skeleton), **not** `"Direct message"`. The kind label is only correct as a terminal state, after resolution has actually been attempted and failed.

## Workstreams

| ID | Workstream | Depends on | Parallel with |
|----|-----------|-----------|---------------|
| A | Persist `title` in the BFF store | — | D |
| B | Graph name-resolution: log + retry | — | A, C, D |
| C | Client fallback + pending state | A | — |
| D | Deep-link stub hydration | — | A, B |
| E | Bug sweep + live verification | A–D | — |

### A — Persist `title` in the BFF store (one session)

- `apps/chat-server/src/store.ts`: add `title TEXT` to the `conversations` schema **and** an idempotent `ALTER TABLE conversations ADD COLUMN title TEXT` migration guarded on `PRAGMA table_info` (existing DBs on the probe host must upgrade in place).
- `ConversationInput` gains `title?: string | null`; `upsertConversations` writes it. The existing `DO UPDATE … WHERE excluded.last_message_version > conversations.last_message_version` gate means a title that resolves *later* would not land until the next version bump — so title updates go through a **separate small `UPDATE … SET title = ? WHERE … AND ? <> ''`** that is not version-gated and never clears a stored title with an empty value.
- `listConversations` selects and returns `title`.
- `upsert-map.ts` `toConversationInput` maps `c.title`.
- Sweep already re-reads the store post-upsert, so `sweep.ts` needs no change once the store round-trips the title. Verify `ws-hub.ts:49`'s snapshot carries it.

### B — Graph name-resolution: log + retry (one session)

- `web/server.mjs:1135` `resolveTeamsNamesInPage`: return a typed reason (`no_token` / `http_{status}` / `throw`) alongside the map instead of a bare `{}`; log it once per failure at the `teamsResolveTitles` call sites.
- Retry the batch once on a failure that is plausibly transient (missing token key, 5xx, 429) with a short backoff. Do not retry a 403.
- Keep the never-throw contract: the list must render even when resolution fails.

### C — Client fallback + pending state (one session, after A)

- `chat/src/lib/conversation-view.ts` `conversationLabel`: add a `pending` terminal so a caller can distinguish "not resolved yet" from "resolved to nothing". Kind label only in the latter case.
- Provisional label from known sender names for a title-less conversation (a 1:1's other participant is the only non-self sender in its history).
- Skeleton in `conversation-row` + the thread header while pending.
- De-duplicate the inline fallback chain at `chat-app.tsx:490` (⌘K palette) onto `conversationLabel` so there is one source of truth.

### D — Deep-link stub hydration (one session)

- `chat/src/chat-app.tsx:142` `stubConversation`: resolve from the loaded conversation list by id first. On a miss, hydrate from the roster/history response before the header commits, showing the pending state meanwhile.
- Drop the hardcoded `kind: "oneOnOne"` guess once the real row is available.

### E — Bug sweep + live verification (last)

- Re-read the diff for regressions; run the full check suite; live-verify on the probe host.

## Acceptance checklist

- [ ] `conversations` table has a `title` column; an **existing** probe-host DB migrates in place without data loss.
- [ ] A WS `conversation-upsert` frame (sweep tick, `refreshConvRow`, and the `ws-hub` connect snapshot) carries the resolved `title`.
- [ ] Reconnecting the WS with a resolved DM list does **not** flip any row to `"Direct message"`.
- [ ] A resolved title is never overwritten by an empty one; a *changed* title (rename/topic set) still lands.
- [ ] A Graph name-resolution failure is logged with a reason and retried once; the list still renders.
- [ ] A title-less DM shows a loading skeleton while resolution is pending — never `"Direct message"` — and the kind label only after a failed attempt.
- [ ] A push deep-link opens with the real conversation name (or the pending skeleton), not `"Direct message"`.
- [ ] ⌘K palette and the list row use the same label function.
- [ ] `vitest` + `typecheck` + `lint` green; new unit tests cover the store title round-trip, the empty-title no-clobber rule, and the pending-vs-terminal label branch.
- [ ] Live `/cdp` verification against `100.85.206.8:9222`: open `/chat`, confirm DM names, force a WS reconnect, confirm names survive.

## Risks

- **Migration on a live DB.** `ALTER TABLE` must be guarded and idempotent; a second boot must not throw. Mitigate with a `PRAGMA table_info` check and a boot test against a pre-migration fixture DB.
- **Version-gated upsert.** Adding `title` to the gated `DO UPDATE` would make a late-resolving title wait for a message-version bump. The separate ungated title update avoids this but must not resurrect a title for a conversation that was legitimately renamed to empty (topic cleared) — a cleared topic still yields a *composed member-name* title, so "empty" only ever means "unresolved". Assert this in a test.
- **Stale title after a rename.** Persisted title updates on the next HTTP list fetch. Acceptable; a group rename is rare and self-corrects within one poll.
- **Provisional label from sender names** can name the wrong party in a group-DM. Restrict it to `kind === "oneOnOne"`.
- **Retry cost.** The Graph batch runs in the keeper tab; one retry with backoff is cheap, but a retry storm on a hard 403 must be excluded.

## Out of scope

- Slack titles (`core/slack-render.js` `composeTitle`) — a different code path, not reported.
- Persisting the *composed* title on the `server.mjs` side (`teams_conversations`); the BFF store is now the read model the FE uses.
- Any change to the MRI/oid parsing rules in `core/teams-names.js` — verified correct against the live tenant.
- Avatar / facepile resolution (`avatarUserId`, `memberIds`), even though it shares the same MRI resolution seam.
- Group-DM given-name formatting rules.
