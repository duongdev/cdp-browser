# 107 — teams message read: /api/teams/history + teams-render + thread pane + list+pane layout

- **Status:** done
- **Mode:** HITL
- **Depends on:** t105 (creds + store + in-page seam), t106 (chat app shell + list)
- **Blocks:** t108 (reply), t109 (sweep/reconcile), t110+ (rich compose)

## Goal

Tapping a conversation in the chat app opens a **thread view** showing its real messages,
rendered from Teams' HTML (sanitized — never `innerHTML`). Introduces the **list+pane**
layout (two-pane on wide, stacked list→thread→back on phone). Messages come from a new
in-page (CA-proof) read endpoint, rendered by a pure `core/teams-render.js` and persisted
to the `messages` table t105 created. Read-only in this task — reply is t108, edit/delete
reconcile is t109, adaptive cards are t112 (a card degrades to a labelled chip here).

## Scope

- **`core/teams-render.js`** (pure, CJS, DI-free; TDD) — mirror `core/slack-render.js`'s
  contract so the UI shape is identical:
  - `renderBody(message)` — Teams message `content` is **HTML** (`messagetype`
    `RichText/Html` or `Text`): strip to a safe subset / plain text (NO raw innerHTML —
    remove scripts/styles/event attrs), resolve `<at id=…>` mentions from the message's
    `properties`/`mentions`, decode HTML entities, collapse whitespace. A card/attachment
    (`properties.cards`, `attachments`) degrades to a `[card]`/`[attachment: name]` chip.
  - `toReaderMessages(raw, selfId)` — map the msg-service message list to
    `ReaderMessage[]` = `{ id, ts, senderId, senderName, body, self, edited, deleted }`
    (self = senderId === selfId; edited from `properties.edittime`; deleted from a tombstone
    / `deletetime`). Filter control/system messages (`messagetype` `ThreadActivity/*`).
  - `composeTitle(conv)` — "{topic}" or DM sender, mirroring slack-render.
- **`core/teams-store.js`** — add `upsertMessages(db, tenant, convId, msgs)` (insert by
  `(conv_id,id)`; store `version`, `deleted`, `edited`, `content`, `ts`, sender) and
  `listMessages(db, tenant, convId, { before?, limit })` (newest-first page, cursor by ts).
  Update `oldest_synced_ts`/`newest_synced_ts` from the fetched range. Reconcile-by-version
  (edit/delete) is t109 — here insert/replace is enough. TDD against `:memory:`.
- **Read endpoint** — `POST /api/teams/history` `{ convId, before? }` (mirror
  `/api/slack/history`): `getTeamsCreds(tenant)` → **in-page** fetch
  `{chatServiceBase}/v1/users/ME/conversations/{convId}/messages?pageSize=30[&startTime=…]`
  via `runInTeamsPage` (CA-proof) → `teams-render.toReaderMessages` → `upsertMessages` →
  return `{ messages }`. 401 → `markTeamsCredsStale` + one re-authz retry → typed
  `invalid_auth`. `before` drives backward paging (scroll-back).
- **Chat app UI** — `chat/src/components/thread-view.tsx`: fetch + render a conversation's
  messages (sender, relative time, rendered body; own messages right-aligned/accented),
  four states (loading / empty / error+retry / populated), **scroll-back** loads older on
  scroll-to-top (lazy, uses `before` cursor). Wire the **list+pane layout** in
  `chat-app.tsx`: wide ≥ breakpoint → conversation list (left) + thread (right); phone →
  list, tap opens thread full-width with a back button. `onOpenConversation(convId)` (t106's
  inert placeholder) now selects the conversation. A small typed client method
  `fetchHistory(convId, before?)` on `chat/src/lib/teams-client.ts`.

## Acceptance criteria

- [ ] `core/teams-render.js` renders Teams HTML to safe text (no script/style/handlers),
      resolves `<at>` mentions, decodes entities, cards→chip; `toReaderMessages` maps +
      filters system messages + flags self/edited/deleted. TDD covers each.
- [ ] `teams-store.upsertMessages`/`listMessages` persist + page (cursor by ts). TDD.
- [ ] `POST /api/teams/history` returns rendered `ReaderMessage[]` via the in-page
      (CA-proof) fetch; 401 → one re-authz retry → `invalid_auth`; `before` pages older.
- [ ] Tapping a conversation opens the thread view rendering its messages; scroll-to-top
      loads older; own messages are visually distinct.
- [ ] list+pane: two-pane on wide, stacked list→thread→back on phone.
- [ ] Four states covered in the thread view.

## Test plan

- **Layer 1 (TDD):** `teams-render` (renderBody sanitize/mention/entity/card cases;
  toReaderMessages self/edited/deleted/system-filter; composeTitle) + `teams-store`
  (upsertMessages insert/replace, listMessages paging + cursor). 
- **Layer 2 (smoke):** with a live Teams keeper, `curl -XPOST /api/teams/history
  {convId}` → rendered messages; `before` returns an older page.
- **Layer 3 (visual, REQUIRED):** screenshots of the thread view (populated w/ mocked
  history, empty, error) + the list+pane at wide and the stacked flow at phone width.

## Design notes

- `teams-render.js` is the Teams analog of `slack-render.js` — SAME output contract
  (`ReaderMessage`) so the thread view is content-source-agnostic. Sanitize with an
  allowlist; never assign innerHTML. Adaptive-card rendering is t112 (chip now).
- Keep the read behind `teams-client.fetchHistory` so t109 (live sync) swaps the source
  without touching the view.
- Covered by ADR-0018; no new ADR.

## Out of scope

- Reply / compose (t108). Edit/delete **reconcile** by version + `consumptionHorizon`
  mark-read (t108/t109). Poll sweep + live sync + `clientmessageid` dedup (t109).
  Reactions/rich compose (t110+). Adaptive-card rendering (t112). Eager recent-N backfill
  of ALL conversations (t109 sweep — t107 only reads the opened conversation + scroll-back).

## Definition of Done

- [ ] Layer 1 green; Layer 2 smoke (live keeper); Layer 3 screenshots captured.
- [ ] `pnpm check` (touched), `pnpm typecheck`, `pnpm test`, `node --check web/server.mjs`.
- [ ] CLAUDE.md updated (`core/teams-render.js`, the `/api/teams/history` route, the chat
      app thread view + list+pane).
- [ ] No AI attribution / console debris. Task → done, moved to `done/`, `t107` in commit.

## Notes

- Worktree caveat: `docs/` symlink is unstable — docs commit on `main`, code on the feature
  branch (2-commit ship); never `git add -A`; `--no-verify` (rtk breaks pre-commit).
- teams msg message shape (from the `/messages` fetch): `{ id, originalarrivaltime |
  composetime, from (mri), imdisplayname, content, messagetype, properties, ... }`. `from`
  carries the sender MRI (`8:orgid:{oid}`); self = matches the creds' userId.
