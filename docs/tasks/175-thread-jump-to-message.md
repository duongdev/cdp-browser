# 175 — thread jump-to-message: ?msg anchor served from chat.db

- **Status:** ready
- **Mode:** HITL
- **Estimate:** 1d
- **Depends on:** t174
- **Blocks:** none

## Goal

`/chat/c/{convId}?msg={id}` lands the thread on the cited message: the FE fetches a message window *around* the target from `chat.db` (t171's `getContextWindow` exposed as a history variant — no Teams cursor walk), renders it in a jump mode with the target highlighted, and a load-newer path walks forward to rejoin the live newest page. Assistant citation chips (t174) get full precision (grilled: full scroll-to-message).

## Why now

Citations to old messages are weak without it — the chip opens the conversation but the evidence is pages away. The DB already holds the cited message, so the walk is local and bounded.

## Acceptance criteria

- [ ] History endpoint accepts an `aroundMsgId` (or ts) form returning a DB-served window `{messages, hasOlder, hasNewer}` — provider cursors untouched.
- [ ] Thread pane jump mode: entering via `?msg` renders the window, scrolls to + highlights the target (brief accent, fades), works within the `flex-col-reverse` scroll model without viewport jumps.
- [ ] Both sentinels work in jump mode: top loads older (existing path), bottom loads newer DB pages until the window rejoins the live newest page — then the pane seamlessly returns to normal live mode (poll/WS deltas resume appending).
- [ ] A "jump to latest" affordance exits jump mode instantly.
- [ ] Target message not in DB (never synced/deleted): honest fallback — conversation opens at newest with a small "message not available" notice; no spinner dead-ends.
- [ ] Deep link works cold (app boot from URL) and warm (chip click), on wide and phone shells.
- [ ] Read-state semantics: opening in jump mode still follows the existing local-read rules (no special-casing that breaks mark-unread).

## Test plan

### Layer 1 — Pure logic (TDD)

- [ ] window fetch shaping — around-target bounds, hasOlder/hasNewer flags, rejoin detection (newest window overlaps live page)
- [ ] jump-mode reducer — enter/extend/rejoin/exit transitions, target-missing fallback

### Layer 2 — Manual smoke (CDP/IPC)

n/a — BFF DB reads only (covered by Layer 1 against `:memory:`).

### Layer 3 — Visual review

- [ ] Jump to a months-old cited message: no scroll jank, highlight visible, load-newer rejoins live cleanly
- [ ] Phone shell: same flow stacked

## Design notes

- **Contracts changed:** history request/response in `contract.ts` grows the around-form + `hasNewer`.
- **New modules:** jump-mode state lib in `chat/src/lib/` (pure, tested); thread-view + message-merge gain a windowed mode.
- **New ADR needed?** no.

Careful with `mergeMessages`: jump windows must not be merged into the live newest-page array (separate windowed state until rejoin) or dedup/ordering assumptions break.

## Out of scope

- Provider (Teams) backfill for messages older than what's synced — DB-only; t-backfill already exists separately.
- Search-in-thread UI (different feature).

## Definition of Done

- [ ] Layers 1 + 3 done as above
- [ ] `pnpm check:changed` clean, `pnpm typecheck` clean, `pnpm test` green, `pnpm chat:build` succeeds
- [ ] CLAUDE.md updated (chat app section)
- [ ] Task closed: status → done, file moved to `docs/tasks/done/`, tNNN in commit
