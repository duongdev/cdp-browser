# 075 — users.counts fallback for restricted grid workspaces

- **Status:** done
- **Mode:** HITL
- **Estimate:** 0.5d
- **Depends on:** 071
- **Blocks:** none

## Goal

Cover Enterprise Grid child workspaces that the sweep currently can't read. Live probing found these return `team_is_restricted` from `client.counts` (org policy) but **not** from `users.counts` — the legacy equivalent still works and carries per-channel `mention_count_display` / `unread_count_display` / `is_muted` and per-DM `dm_count`. So when `client.counts` is restricted, fall back to `users.counts`, normalized into the same shape the reducer consumes. After this, a Grid-restricted workspace becomes a covered (degraded-mode) sweep instead of "unsupported".

## Why now

The one known limitation from ADR-0011 (verified live against Example's child workspace T0EXAMPLE01). The fallback path is de-risked by live probes (`auth.test`, `conversations.list`, `users.counts` all OK on the restricted child).

## Acceptance criteria

- [ ] `slack-api.js` gains `usersCounts()`.
- [ ] When `client.counts` returns `team_is_restricted`, the sweep uses `users.counts` (normalized) instead of marking the workspace unsweepable.
- [ ] `users.counts` has no `last_read`/`latest`, so the restricted path seeds the watermark to "now" (no history fetches, no cold-start spam) and reads-syncs via the unread-set (an entry whose channel is no longer unread flips to read).
- [ ] Mute comes from `users.counts` `is_muted` on the restricted path (no `users.prefs` call).
- [ ] Channel parity unchanged (a channel still needs a real @-mention in the message text).
- [ ] If `users.counts` also fails, the workspace is marked unsweepable (hijack fallback) as before.
- [ ] Health reports a restricted-but-covered workspace as healthy (not unsupported).

## Test plan

### Layer 1 — Pure logic (TDD)

- [ ] `normalizeUsersCounts` — channels with mentions/unreads → has_unreads + mention_count; ims with dm_count → has_unreads; is_muted → muted list; synthesized last_read.
- [ ] runner restricted path — seeds to now, notifies a post-seed message, read-syncs via unread-set.

### Layer 2 — Manual smoke (CDP/IPC)

- [ ] Against the live restricted child (T0EXAMPLE01), the sweep seeds via users.counts and a simulated unread produces an entry.

### Layer 3 — Visual review

n/a — no new UI (health status flips unsupported→healthy).

## Design notes

- **Contracts changed:** the runner's counts source becomes `fetchCounts(api)` returning `{ counts, restricted, muted }`. Restricted path: seed-to-now + unread-set read-sync.
- **New modules:** none — extends `slack-sweep-runner.js` + a pure `normalizeUsersCounts`.
- **New ADR needed?** no — amends ADR-0011's Grid limitation note.

## Out of scope

- Per-message read-sync on the restricted path (it's whole-conversation via the unread-set; client.counts path keeps per-message last_read).
- Replicating Slack's websocket unread protocol.

## Definition of Done

- [ ] Layer 1 tests green
- [ ] Layer 2 smoke against the live restricted child
- [ ] `pnpm check` / `pnpm typecheck` / `pnpm test` green
- [ ] `node --check web/server.mjs` clean
- [ ] CLAUDE.md + ADR-0011 limitation note updated
- [ ] No debris, no AI attribution
- [ ] Task closed: status → done, moved to `done/`, t075 in commit

## Notes

Also fixed a robustness bug found en route: a non-JSON Slack response (wrong base URL / SSO wall) crashed `slack-api.js`'s `resp.json()`; it now returns a typed `bad_response`.

---

_When task status flips to `done`, move this file to `done/`._
