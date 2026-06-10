# 073 — slack notification content rendering

- **Status:** done
- **Mode:** AFK
- **Estimate:** 0.5d
- **Depends on:** 071
- **Blocks:** none

## Goal

Make swept Slack entries read like real Slack notifications. Title `"{sender} in {channel}"` (DM: just sender); body = message text with `<@U…>` → `@name` and basic mrkdwn stripped. A per-workspace user/channel map is cached and lazily filled via `users.info`. Without this, sweep entries show raw `<@U07AB>` ids and mrkdwn.

## Why now

Polish on top of the live sweep (071). Independent of excludes (072). ADR-0011 phase 10.

## Acceptance criteria

- [ ] Title is `"{sender} in {channel}"`; DMs show just the sender.
- [ ] Body resolves `<@U…>` to `@name` and strips basic mrkdwn (`*bold*`, `_italic_`, `~strike~`, links).
- [ ] A per-workspace user/channel map is cached; unknown users are filled lazily via `users.info` (no fetch storm).
- [ ] An unresolved id degrades gracefully (shows a readable fallback, never a crash).

## Test plan

### Layer 1 — Pure logic (TDD)

- [ ] mrkdwn → plain text — bold/italic/strike/link/code, nested, unmatched markers.
- [ ] `<@U…>` substitution with a supplied name map — present, missing (fallback), multiple.
- [ ] title composition — channel message vs DM.

### Layer 2 — Manual smoke (CDP/IPC)

- [ ] A real message with a mention + formatting renders cleanly in the bell + push.

### Layer 3 — Visual review

- [ ] Bell list entries read naturally; no raw ids or markers.

## Design notes

- **Contracts changed:** sweep entry title/body now rendered, not raw; a cached name resolver is added to the sweep path.
- **New modules:** a pure mrkdwn/mention renderer (`core/slack-render.js` or folded into the sweep) — testable.
- **New ADR needed?** no — ADR-0011.

## Out of scope

- Rich formatting (attachments, blocks, images) — plain text only.
- Matching the hijack's output (explicitly not constrained to it; the sweep has richer data).

## Definition of Done

- [ ] Layer 1 tests green (render matrix)
- [ ] Layer 2 smoke completed
- [ ] `pnpm check` / `pnpm typecheck` / `pnpm test` green
- [ ] CLAUDE.md (core list) updated
- [ ] No debris, no AI attribution
- [ ] Task closed: status → done, moved to `done/`, t073 in commit

## Notes

Lazy fill: resolve on miss, cache forever per workspace; `users.info` is rate-limited so batch where Slack allows.

---

_When task status flips to `done`, move this file to `done/`._
