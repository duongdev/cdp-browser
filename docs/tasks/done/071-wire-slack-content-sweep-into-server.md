# 071 — wire slack content sweep into server

- **Status:** done
- **Mode:** HITL
- **Estimate:** 1d
- **Depends on:** 067, 068, 069, 070
- **Blocks:** none

## Goal

Run the sweep: fold a poll loop into the server's reconcile cycle that, per registered workspace with fresh creds, calls the Slack client (067), feeds the reducer (068), ingests the resulting entries into the store, and applies read updates. The sweep becomes the **authoritative writer of Slack store entries**; the in-page `window.Notification` hijack is demoted to an instant foreground toast that no longer writes Slack entries. After this task, Slack notifications are complete independent of native-app routing, tab focus, tab sleep, tab closure, and server gaps.

## Why now

This is the payoff — the phase that actually closes the failure class. Everything before it is foundation. ADR-0011 phase 6.

## Acceptance criteria

- [ ] A poll loop per registered workspace runs on the reconcile cadence; each poll: `clientCounts` → fetch history for changed channels → reducer → `ingest` new entries + apply read updates.
- [ ] Slack entries written by the sweep are keyed `slack:{team}:{channel}:{ts}`; re-polls produce no dupes.
- [ ] The Slack hijack capture script no longer ships store entries — it only signals an instant foreground toast.
- [ ] A workspace with stale creds is skipped (not errored) and left to 069/074 to surface.
- [ ] Single-workspace latency for the existing screencast/notification path does not regress (the sweep runs headless off the reconcile loop, not the fan-out path).
- [ ] Server gap (server down for minutes) → on restart, the next poll catches up via the watermark; nothing is lost.

## Test plan

### Layer 1 — Pure logic (TDD)

n/a here — logic is in 068; this task is the effectful loop. Add a thin integration test if a seam allows.

### Layer 2 — Manual smoke (CDP/IPC)

- [ ] Send yourself a Slack DM with the workspace tab backgrounded and the remote window focused (the case the hijack misses) — confirm the entry appears via the sweep.
- [ ] Read it on your phone — confirm the entry flips to read on the next poll.
- [ ] Stop the server for 2 minutes, send a DM, restart — confirm the entry is caught up.
- [ ] Confirm the foreground toast still fires instantly when the tab is live (hijack path intact).

### Layer 3 — Visual review

- [ ] Bell list + badges reflect swept Slack entries with correct per-workspace grouping.

## Design notes

- **Contracts changed:** Slack adapter capture → toast-only; the notification center gains the sweep as a second ingest source. Hijack no longer the Slack store writer.
- **New modules:** none — composes 067/068/070 inside `web/server.mjs`.
- **New ADR needed?** no — ADR-0011 is the decision record.

## Out of scope

- Channel exclude UI (072), name rendering (073), health surface (074) — entries may read rough and excludes may be config-only until those land.
- Electron: the sweep is web-server-only; Electron continues with the hijack (the single-store divergence is acknowledged, addressed if/when Electron consumes the server store).

## Definition of Done

- [ ] Layer 2 smoke completed (the four scenarios above)
- [ ] `pnpm check` / `pnpm typecheck` / `pnpm test` / `pnpm test:e2e` green
- [ ] `node --check web/server.mjs` clean
- [ ] No single-workspace latency regression (spot-check frame cadence)
- [ ] CLAUDE.md + CONTEXT.md updated (sweep is now authoritative for Slack)
- [ ] No debris, no AI attribution
- [ ] Task closed: status → done, moved to `done/`, t071 in commit

## Notes

After this lands, verify on the live iPad PWA before declaring the failure class closed (memory `web-pwa-is-priority-surface`, `verify-locally-before-deploy`).

---

_When task status flips to `done`, move this file to `done/`._
