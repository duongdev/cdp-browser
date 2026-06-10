# 070 — slack workspace registry and parked-tab keeper

- **Status:** done
- **Mode:** HITL
- **Estimate:** 1d
- **Depends on:** 069
- **Blocks:** 071

## Goal

Persist a Slack workspace registry (`slack-workspaces.json`, `teamId → { url, creds, lastSeen }`) populated the first time a workspace tab is seen live, and add a parked-tab keeper that ensures exactly one tab per registered workspace exists on the remote browser — recreated via `/json/new` if closed or after a browser restart. This makes the sweep survive tab closure: creds self-refresh and the hijack stays armed even when you close the visible workspace tab.

## Why now

"No miss when the tab is closed" depends on a tab existing to refresh creds. The server wiring (071) reads the registry to know which workspaces to sweep. ADR-0011 phases 5 + 8.

## Acceptance criteria

- [ ] `slack-workspaces.json` persists `teamId → { url, creds, lastSeen }`; a workspace is registered on first live sighting.
- [ ] The keeper, folded into the existing 5s reconcile loop, ensures one tab per registered workspace exists; recreates a missing one via `/json/new` (Edge `PUT`).
- [ ] A registered workspace whose tab the user closes is re-provisioned (accepted UX: tabs may visibly reappear).
- [ ] New workspaces are added only by the user opening them once — the keeper never invents a workspace.
- [ ] Browser restart → keeper re-provisions all registered workspaces.

## Test plan

### Layer 1 — Pure logic (TDD)

- [ ] registry reducer — register on first sight, update `lastSeen`, never duplicate a `teamId`.
- [ ] keeper diff — given registered set + live targets, returns which workspaces to create (pure plan, effects in caller).

### Layer 2 — Manual smoke (CDP/IPC)

- [ ] Register two workspaces, close one tab, confirm it's recreated within a reconcile cycle.
- [ ] Restart the remote browser, confirm both reappear.

### Layer 3 — Visual review

- [ ] Parked tabs appear in the Tabs list as normal tabs (no broken state).

## Design notes

- **Contracts changed:** new server persistence file + a keeper plan injected into the reconcile loop.
- **New modules:** registry reducer + keeper diff (pure); the effectful `/json/new` calls live in `web/server.mjs`.
- **New ADR needed?** no — ADR-0011 (server-provisions-tabs consequence recorded).
- Distinct from ADR-0010 Workspaces (multi-CDP-host UI), though both carry a workspace key.

## Out of scope

- Polling Slack / synthesizing entries (071).
- Hiding parked tabs in a separate context (explicitly rejected in ADR-0011).

## Definition of Done

- [ ] Layer 1 tests green
- [ ] Layer 2 smoke completed (close + restart re-provision)
- [ ] `pnpm check` / `pnpm typecheck` / `pnpm test` green
- [ ] `node --check web/server.mjs` clean
- [ ] CLAUDE.md updated; `slack-workspaces.json` documented near the other server state files
- [ ] No debris, no AI attribution
- [ ] Task closed: status → done, moved to `done/`, t070 in commit

## Notes

`slack-workspaces.json` sits next to `web-settings.json` / `web-notifications.json` / `web-push-subs.json`.

---

_When task status flips to `done`, move this file to `done/`._
