# 068 — slack sweep reducer

- **Status:** done
- **Mode:** AFK
- **Estimate:** 1d
- **Depends on:** 067
- **Blocks:** 071

## Goal

Add `core/slack-sweep.js` — the pure watermark/parity reducer at the heart of the content sweep (ADR-0011). Given `client.counts`, fetched history, the per-channel watermark, the exclude list, and `last_read`, it returns the set of new notification entries to ingest (keyed by stable `slack:{team}:{channel}:{ts}`) plus the read-state updates. No I/O — the server injects the Slack client, the clock, and the store. This is where "Slack-parity + excludes" and "follow `last_read`" become concrete.

## Why now

The brain of the sweep. The server wiring (071) is just effects around this reducer. Built TDD before any live integration so parity rules are pinned by tests. ADR-0011 phase 3.

## Acceptance criteria

- [ ] `core/slack-sweep.js` exports a pure function: `(counts, history, watermark, excludes, lastReadMap) → { newEntries, readUpdates, nextWatermark }`.
- [ ] Parity baseline: DMs + group DMs always; channel messages only when a mention (incl. `@here`/`@channel`) is present; unread thread replies included.
- [ ] Honors Slack muted-channel flag from counts.
- [ ] Applies the `Channel Exclude` list (by stable channel id) on top.
- [ ] Entry ids are stable `slack:{team}:{channel}:{ts}` — re-running with the same inputs yields no new entries (idempotent via watermark + the downstream `ingest` id guard).
- [ ] `readUpdates` flips entries older than each channel's `last_read` to read.

## Test plan

### Layer 1 — Pure logic (TDD)

- [ ] DM unread → entry; channel message without mention → no entry; channel mention → entry.
- [ ] Muted channel → no entry even with a mention.
- [ ] Excluded channel → no entry.
- [ ] Re-run with advanced `last_read` → entries flip to read, no dupes.
- [ ] Watermark advance → only messages newer than the prior watermark synthesize.
- [ ] Thread reply unread → entry.

### Layer 2 — Manual smoke (CDP/IPC)

n/a — pure module; integration verified in 071.

### Layer 3 — Visual review

n/a.

## Design notes

- **Contracts changed:** Slack entry id scheme — wall-clock `slack:{team}:{Date.now()}:{seq}` → message-anchored `slack:{team}:{channel}:{ts}`. This is the dedup-for-free property.
- **New modules:** `core/slack-sweep.js` — pure reducer, mirrors `core/notifications.js` pattern.
- **New ADR needed?** no — ADR-0011.

## Out of scope

- Fetching (067), creds (069), store writes / poll loop (071), name resolution (073).

## Definition of Done

- [ ] Layer 1 tests green (the parity matrix above)
- [ ] `pnpm check` / `pnpm typecheck` / `pnpm test` green
- [ ] CLAUDE.md (core list + src/lib if a renderer mirror is added) updated
- [ ] No debris, no AI attribution
- [ ] Task closed: status → done, moved to `done/`, t068 in commit

## Notes

The watermark is an optimization; completeness ultimately rests on the `ingest` id guard, so a missed watermark advance can never create a dupe — only a redundant history fetch.

---

_When task status flips to `done`, move this file to `done/`._
