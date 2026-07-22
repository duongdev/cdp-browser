# 113 — teams chat live sync (poll-first): open-thread fast poll + list refresh with edit/delete reconcile

- **Status:** done
- **Mode:** HITL
- **Estimate:** 1d
- **Depends on:** t107 (thread), t108 (send), t110 (keep-alive), t112 (history/list fetch)
- **Blocks:** unified push (server-side sweep loop + toast→sweep-now trigger lands there)

## Goal

New messages appear in the open conversation **without a manual refresh**, and the
conversation list stays current (preview + time + ordering) on its own. Poll-first
(decision 4): the client fast-polls the active thread and periodically refreshes the list;
edits and deletes reconcile in place on the open thread. After this ships, the chat app
*feels live* while it's open — read/reply stops needing a reload.

## Why now

t105–t112 built a working read/reply client, but it only updates on mount / open. Heavy
daily use means a conversation is left open and messages arrive — today you must reopen it.
This is the last core-usability gap before UI polish. Deliberately **client-driven**: the
server already fetches-in-page → upserts → returns fresh on every `/api/teams/history` and
`/api/teams/conversations` call, so realtime is a client poll + merge — **zero server
change**. The server-side backstop sweep (for when *no client* is open) and the toast→sweep
trigger belong to the **unified push** task (decision 7), where server-side ingestion
actually matters; building them now is premature (no push consumer yet).

## Acceptance criteria

- [ ] With a conversation open, a message sent to it from another Teams client appears in the
      thread within ~5s, no manual refresh, and the view auto-scrolls to it **only if the user
      was already at/near the bottom** (reading older history is not yanked).
- [ ] Editing a message on another client updates its bubble in place (content + "edited"),
      and deleting it tombstones the bubble — **for messages within the newest polled page**.
- [ ] The user's own just-sent message is not duplicated when the poll returns it (the
      optimistic bubble and the server copy share the same id → one bubble; server copy wins).
- [ ] The conversation list reorders + updates preview/time when a new message lands in any
      conversation, within ~15s, without disturbing an in-flight "Load more" or losing
      already-loaded older pages.
- [ ] Polls pause when the tab is hidden (`document.hidden`) and fire an immediate refresh on
      re-focus; a poll error never clobbers a good thread/list (last-good stays on screen).
- [ ] Inactive kept-alive panes don't poll; switching back to one triggers one immediate
      refresh so it's current within a tick.

## Test plan

### Layer 1 — Pure logic (TDD)

- [ ] `mergeMessages(existing, incoming)` — appends genuinely-new messages in ts order;
      dedups by id (optimistic-send echo collapses to one); **incoming/server wins on
      conflict** so an edited body / `edited` / `deleted` flag reconciles in place; empty
      incoming is a no-op; returns a `changed` flag that is false when nothing moved.
- [ ] `mergeConversations(existing, freshPage)` — updates a matched conversation's
      preview/ts/title by id; inserts a brand-new conversation; **keeps** conversations only
      present from older pages (not in the fresh page); re-sorts by `lastMessageTs` desc;
      stable (same array contents) when the fresh page changes nothing.

### Layer 2 — Manual smoke (live keeper, orchestrator-run)

- [ ] Open the self-chat `48:notes` is reserved — instead open a real DM; from another Teams
      client post a message → appears in the open thread within ~5s. (Send-testing rule: only
      self-chat for *our* sends; here the second message originates on the real client, read-only
      for us.)
- [ ] Edit that message on the other client → the open thread's bubble updates within a poll.
- [ ] The list row for that conversation moves up + shows the new preview within ~15s.

### Layer 3 — Visual review

- [ ] Stubbed thread: two poll ticks inject a new message → new bubble appears, auto-scrolls
      when pinned to bottom; when scrolled up, position is preserved (no jump).
- [ ] Stubbed list: a poll tick updates a row's preview/time and reorders it to the top.

## Design notes

Describe behavior, not paths.

- **Contracts changed:** none. `TeamsMessage`, `TeamsConversation`, and all `/api/teams/*`
  routes are byte-unchanged. This is pure client-side polling over the existing seams.
- **New modules:**
  - `chat/src/lib/message-merge.ts` — pure `mergeMessages(existing: TeamsMessage[], incoming:
    TeamsMessage[]) → { messages: TeamsMessage[]; changed: boolean }`. Dedup key = `id`; on a
    collision the **incoming** (authoritative server render) replaces the existing, which is how
    edits/deletes reconcile and how the optimistic-send echo collapses. New ids append in ts
    order.
  - `chat/src/lib/conversation-merge.ts` — pure `mergeConversations(existing, freshPage) →
    TeamsConversation[]`. Update-by-id, insert-new, keep-unknown, re-sort by `lastMessageTs`.
- **New ADR needed?** No — poll-first is ADR-0018 decision 4; this is its client half.

Polling wiring (effectful, in the components — the merge logic is the pure/tested part):

```ts
// thread-view.tsx — only the active+visible pane, paused when the tab is hidden.
// Every ~4s: fetchHistory(convId) (newest page, no cursor) → mergeMessages → setState.
// Scroll: capture "was near bottom" BEFORE applying; if so, scrollTop = scrollHeight after.
// On becoming visible: one immediate poll. Poll errors are swallowed (never setState error).

// conversation-list.tsx — every ~12s + on visibilitychange→visible:
// fetchConversations() (page 1) → mergeConversations(current, page.conversations).
// Do NOT touch the older-page cursor or loadingMore; only union/update/reorder.
```

Why no `version` reconcile client-side: `TeamsMessage` carries `edited`/`deleted` but not
`version` (ReaderMessage omits it). A field diff (body/edited/deleted differ → replace) is
sufficient and simpler; the server keeps the `(conv_id, id)` version gate. **clientmessageid
echo-dedup is subsumed by id-dedup** — the optimistic append already uses `out.ts` (the real
arrival-ms = the id history returns), so no separate clientmessageid tracking is needed.

## Out of scope

- Server-side backstop sweep loop + toast-capture (`inject/teams-notify.js`) demotion to a
  "sweep-now" trigger → **unified push** task (they only matter with no client open).
- Web push / notifications for Teams → unified push task.
- Trouter / true realtime push (v2) — poll cadence is the latency floor here.
- Reconciling edits/deletes for messages **older** than the newest polled page (needs trouter).
- A "new messages" pill / unread badges → UI polish + read-state tasks.
- Adaptive poll interval; virtualization (react-virtuoso — only if a long thread janks).

## Definition of Done

- [ ] Layer 1 green (both merge reducers, incl. echo-dedup + edit/delete reconcile + keep-unknown).
- [ ] Layer 2 live-verified against the real keeper by the orchestrator.
- [ ] Layer 3 shots (thread live-append pinned vs scrolled; list reorder).
- [ ] `pnpm check`(touched)/`typecheck`/`test`/`node --check web/server.mjs`/chat build clean.
- [ ] CLAUDE.md updated (Teams live-sync poll: cadence, visibility-gating, the two merge
      reducers, the "server loop is deferred to push" note). No AI attribution / console debris.
- [ ] Task → done, moved to `done/`, `t113` in commit.

## Notes

- Worktree: docs on `main`, code on feature branch `Native-Teams-chat-UI` (2-commit ship);
  never `git add -A`; `--no-verify` (rtk breaks pre-commit).
- Keep poll intervals as named consts (thread ~4s, list ~12s) so a later adaptive-pacing task
  has one place to touch. `ponytail:` fixed cadence; adaptive only if the keeper feels the load.
- The active-pane-only poll bounds keeper load: at most one in-page history fetch per ~4s plus
  one list fetch per ~12s, both gated on tab visibility.
