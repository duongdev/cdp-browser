# 072 — slack channel exclude list

- **Status:** done
- **Mode:** HITL
- **Estimate:** 0.5d
- **Depends on:** 071
- **Blocks:** none

## Goal

Let the user silence specific Slack channels for the sweep. Each notification gets a "Mute this channel" action; the muted `{ team, channelId, label }` list is also editable in Settings. Stored in server ui-state so it survives the iPad PWA's localStorage wipe. The sweep reducer (068) already applies an exclude list — this task builds the config surface and persistence that feeds it.

## Why now

Without excludes, a noisy channel floods the bell and badges. Small, user-facing, ships right after the sweep is live. ADR-0011 phase 7.

## Acceptance criteria

- [ ] A "Mute this channel" action on a Slack notification adds `{ team, channelId, label }` to the exclude list.
- [ ] Settings has an editable exclude list (add/remove), showing the label.
- [ ] The list persists in server ui-state (not localStorage).
- [ ] Muting a channel stops new sweep entries for it within one poll cycle.
- [ ] Channel id is the stable key; label is display-only.

## Test plan

### Layer 1 — Pure logic (TDD)

- [ ] exclude-list reducer — add (dedupe by `team`+`channelId`), remove, no-op on duplicate.

### Layer 2 — Manual smoke (CDP/IPC)

- [ ] Mute a channel from a notification; confirm new messages there stop appearing; confirm it persists across a PWA relaunch.

### Layer 3 — Visual review

- [ ] "Mute this channel" action visible on Slack entries.
- [ ] Settings exclude list: empty, populated, after-remove states.

## Design notes

- **Contracts changed:** ui-state gains a `slackExcludes: { team, channelId, label }[]` key; the sweep reads it.
- **New modules:** exclude-list reducer (pure) if not folded into an existing store.
- **New ADR needed?** no — ADR-0011.
- Distinct from a Pin or a muted Local Tab (CONTEXT.md).

## Out of scope

- Honoring Slack's own muted-channel flag — already in the 068 parity baseline.
- Include/watch-all lists (not chosen; sweep scope is parity + excludes).

## Definition of Done

- [ ] Layer 1 tests green
- [ ] Layer 2 smoke completed (mute + persist across relaunch)
- [ ] Layer 3 screenshots captured
- [ ] `pnpm check` / `pnpm typecheck` / `pnpm test` green
- [ ] CLAUDE.md + CONTEXT.md (Channel Exclude) consistent
- [ ] No debris, no AI attribution
- [ ] Task closed: status → done, moved to `done/`, t072 in commit

## Notes

Server-stored because localStorage resets on the iPad PWA (memory `localstorage-resets-in-pwa`).

---

_When task status flips to `done`, move this file to `done/`._
