# 074 — notification capture health surface

- **Status:** done
- **Mode:** HITL
- **Estimate:** 0.5d
- **Depends on:** 069, 071
- **Blocks:** none

## Goal

Make capture failure visible. Add `/api/notifications/health` reporting, per workspace: side-channel attached, hijack armed, creds fresh/stale, last sweep ok, last entry timestamp — and a Settings row that reads it. Today a missed notification is silent; this disambiguates "Slack never fired / creds stale" from "captured but lost downstream," and drives the one-time "reconnect Slack" alert when creds go stale.

## Why now

The diagnostic that proves the failure class is actually closed and flags the one remaining manual case (stale creds, no live tab). Should land alongside the sweep so regressions are observable. ADR-0011 phases 7 (degraded alert) + 9.

## Acceptance criteria

- [ ] `GET /api/notifications/health` returns per-workspace `{ teamId, attached, armed, credsFresh, lastSweepOk, lastEntryTs }`.
- [ ] A Settings row renders the health per workspace (web-only).
- [ ] Stale creds (from 069) show as "capture degraded" and fire a one-time "reconnect Slack" push/alert.
- [ ] Health reflects reality within one reconcile cycle of a state change.

## Test plan

### Layer 1 — Pure logic (TDD)

- [ ] health aggregator — composes registry + side-channel + creds + last-sweep state into the response shape; degraded when creds stale.
- [ ] one-time-alert gate — fires once per stale transition, not every poll.

### Layer 2 — Manual smoke (CDP/IPC)

- [ ] Healthy workspace shows attached/armed/fresh.
- [ ] Expire creds → row flips to degraded and a single "reconnect Slack" alert fires.

### Layer 3 — Visual review

- [ ] Settings health row: healthy, degraded, no-workspaces states.

## Design notes

- **Contracts changed:** new `/api/notifications/health` endpoint; Settings gains a read-only health row.
- **New modules:** health aggregator (pure) + alert gate (pure).
- **New ADR needed?** no — ADR-0011.

## Out of scope

- Auto-recovering stale creds without a tab (handled by the parked-tab keeper, 070).
- Teams/Outlook deep health (report attached/armed for them too, but the sweep-specific fields are Slack-only).

## Definition of Done

- [ ] Layer 1 tests green
- [ ] Layer 2 smoke completed (healthy + degraded)
- [ ] Layer 3 screenshots captured
- [ ] `pnpm check` / `pnpm typecheck` / `pnpm test` green
- [ ] `node --check web/server.mjs` clean
- [ ] CLAUDE.md updated
- [ ] No debris, no AI attribution
- [ ] Task closed: status → done, moved to `done/`, t074 in commit

## Notes

This is the "build diagnostics first" instinct from the original investigation, folded in at the end so it observes the real sweep rather than a guess.

---

_When task status flips to `done`, move this file to `done/`._
