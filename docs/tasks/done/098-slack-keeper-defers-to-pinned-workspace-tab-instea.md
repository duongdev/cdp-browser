# 098 — slack keeper defers to pinned workspace tab instead of forcing reopen

- **Status:** done
- **Mode:** HITL
- **Estimate:** 0.5d
- **Depends on:** none
- **Blocks:** none
- **Shipped:** PR #10 (`f0a456a`) — folded into the t096 sweep

## Goal

The Slack parked-tab keeper (t070, ADR-0011) reopens an anonymous background tab
for every registered workspace whose tab is not currently live — **even when the
user has that workspace pinned**. Closing the workspace's tab immediately spawns a
stray duplicate in the Tabs list, which is annoying. After this task, the keeper
**defers to a pin**: a workspace that has a pin is considered covered by its pin and
the keeper never spawns a duplicate for it. Capture is unaffected because **one live
Slack tab refreshes creds for all workspaces** (shared `d` cookie + `localConfig_v2`
holds every team's token) and the sweep polls every workspace over the web API
regardless of which tab is live. A cred lifeline keeps exactly one Slack tab alive
(preferring a pinned URL) only when no Slack tab is live and nothing else would open
one.

## Why now

Daily-driver annoyance on the priority web/PWA surface: the user pins their Slack
workspaces and the keeper keeps resurrecting closed tabs against their intent. The
fix is small and server-only, and it tightens guaranteed delivery (ADR-0011) rather
than weakening it — capture no longer depends on a per-workspace tab.

## Acceptance criteria

- [ ] A registered workspace that has a pin gets **no** anonymous parked tab from
      the keeper (it is not re-created on close).
- [ ] A registered workspace with **no** pin keeps today's anonymous parked-tab
      behavior (unchanged).
- [ ] Cred lifeline: when **no** Slack tab is live and no unpinned workspace would
      open one, the keeper opens exactly **one** tab, preferring a pinned URL, so
      creds keep refreshing.
- [ ] The cred lifeline respects the existing create-cooldown (no spam).
- [ ] Omitting the pin map preserves byte-identical prior behavior (back-compat).

## Test plan

### Layer 1 — Pure logic (TDD)

- [ ] `core/slack-workspaces.js` `planParkedTabs(registry, live, createdAt, now, pinUrlByTeam)`
      — skips a pinned registered workspace; still plans an unpinned one alongside it.
- [ ] cred lifeline opens one pinned workspace when `live` is empty and no unpinned
      plan exists; uses the pin URL; respects cooldown; does nothing when a tab is
      live or an unpinned plan already keeps one alive.
- [ ] back-compat: omitting `pinUrlByTeam` equals the prior result.

### Layer 2 — Manual smoke (CDP/IPC)

Web build (`pnpm web`) against a live Remote Browser with ≥1 Slack workspace pinned:

- [ ] Pin a Slack workspace, open it, then close its tab → keeper does **not** reopen
      a stray; the workspace still receives notifications (sweep continues).
- [ ] Close **every** Slack tab → keeper opens exactly one (a pinned workspace's URL);
      creds recover and sweeps resume.
- [ ] An unpinned workspace closed → still auto-reopens (unchanged).

### Layer 3 — Visual review

n/a — no renderer UI is touched (server-side keeper only).

## Design notes

- **Contracts changed:** `planParkedTabs` gains an optional 5th arg
  `pinUrlByTeam: { [teamId]: url }`. A workspace whose `teamId` is a key is skipped
  (pin owns it). When `live` is empty and the normal plan list is empty, the planner
  appends **one** lifeline plan from `pinUrlByTeam` (cooldown-gated) so a single
  Slack tab stays alive for shared-cred refresh. Absent/empty map → prior behavior.
- The server (`web/server.mjs` `keepSlackTabsAlive`) derives `pinUrlByTeam` from
  `settings.getPins()` via `teamIdOf(pin.url)` and passes it in. No renderer change.
- **New modules:** none.
- **New ADR needed?** No — this is a tuning of the t070 keeper within ADR-0011.
  Document in CLAUDE.md (keeper bullet + `slack-workspaces.js` note) and the code.

## Out of scope

- Renderer pin-adoption of a keeper-opened tab mid-session (ADR-0004 keeps
  URL-adoption startup-only; the lifeline tab adopts on next reload). Not needed
  for the chosen "don't reopen — pin owns it" behavior.
- Reducing the unpinned per-workspace keeper to one-tab-total (kept as-is per the
  decision).

## Definition of Done

- [ ] Layer 1 tests written and green
- [ ] Layer 2 smoke checklist completed with a live Remote Browser (web build)
- [ ] `pnpm check:changed` clean
- [ ] `pnpm typecheck` clean
- [ ] `pnpm test` green
- [ ] CLAUDE.md updated (keeper bullet + `slack-workspaces.js` note)
- [ ] No commented-out code, no `console.log` debris, no AI attribution
- [ ] Task closed: status → done, file moved to `docs/tasks/done/`, t098 in commit

## Notes

Decided with the user via two grills: (1) "reuse the pin" over "hands-off"; then,
after surfacing the code fact that one live Slack tab refreshes all workspaces'
creds, (2) "don't reopen — pin owns it" with a single-tab cred lifeline. The keeper
was over-aggressive: per-workspace tabs are not needed for the sweep — only one live
Slack tab is.

---

_When task status flips to `done`, move this file to `done/`._
