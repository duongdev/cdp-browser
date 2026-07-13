# 104 — Slack parked-tab keeper poisons registry with non-client slack.com URLs (sso_failed loop)

- **Status:** done
- **Mode:** HITL
- **Estimate:** 0.5d
- **Depends on:** none
- **Blocks:** none

## Goal

The Slack parked-tab keeper must never register a non-workspace `*.slack.com` page as a workspace, and must never fight a broken Slack SSO session by spawning tabs. Today a Slack SSO redirect (`https://acme.enterprise.slack.com/?sso_failed=1`) is parsed as a workspace with `teamId = "acme.enterprise"` (the legacy-subdomain fallback in `parseSlackContext`), persisted into the registry with its raw error URL, and then re-created forever by `planParkedTabs` — an invalid Slack tab the user can't get rid of, plus a phantom workspace the sweep can never fetch creds for (capture health degrades). After this task, only real team ids (`T…`/`E…`) enter the registry, the stored URL is canonical (no query string), an existing poisoned registry self-heals on load, and while an SSO-failed Slack landing page is open the keeper stops creating tabs instead of looping.

## Why now

Observed live on `100.x.x.x:9222`: three page targets, one of them the invalid `acme.enterprise.slack.com/?sso_failed=1` tab that returns after every close. It breaks the daily-driver bar (a tab you can't close), and the phantom workspace makes the Slack capture-health surface permanently degraded, which is the signal the whole ADR-0011 sweep leans on.

## Acceptance criteria

- [x] `parseSlackContext` no longer resolves a `teamId` for a Slack host that is not a real workspace subdomain — `acme.enterprise.slack.com`, `my.slack.com`, `slackhq.slack.com`, `api.slack.com` and friends resolve to `teamId: null`.
- [x] `upsertWorkspace` rejects any id that is not a real team id (`^[TE][A-Z0-9]{6,}$`) and stores a canonical `https://app.slack.com/client/{teamId}` URL, never the observed URL with its query string.
- [x] The registry self-heals: loading a `slack-workspaces.json` that contains a poisoned key drops that entry.
- [x] `planParkedTabs` creates nothing while an SSO-failed Slack landing page is live — opening more tabs cannot fix a dead session, so the keeper backs off and lets capture health degrade instead.
- [ ] The invalid tab on the live remote browser closes and stays closed. — pending deploy (verified the loop still reproduces against the running pre-fix server).

## Test plan

### Layer 1 — Pure logic (TDD)

- [x] `core/notifications.js` `parseSlackContext` — covers: `app.slack.com/client/T…/C…` and `/client/E…` still parse; `acme.slack.com` (real legacy workspace subdomain) still parses; `acme.enterprise.slack.com`, `my.slack.com`, `api.slack.com`, `slack.com` resolve to null.
- [x] `core/slack-workspaces.js` `upsertWorkspace` — covers: a non-team id is rejected (registry unchanged); a valid entry stores the canonical `/client/{teamId}` URL, dropping `?sso_failed=1` and any channel segment.
- [x] `core/slack-workspaces.js` `pruneRegistry` — covers: a poisoned key is dropped, valid keys survive, a valid key with a non-canonical URL is rewritten.
- [x] `core/slack-workspaces.js` `planParkedTabs` — covers: an SSO-failed Slack tab among the targets suppresses every plan (including the cred lifeline); without one, existing behavior (pin-owned skip, cooldown, lifeline) is unchanged.

### Layer 2 — Manual smoke (CDP/IPC)

- [ ] After deploy: close the `?sso_failed=1` tab, confirm it does not come back within two reconcile cycles (the registry self-prunes on server start — no manual file edit needed).
- [ ] After deploy: with a healthy Slack session, close a workspace tab and confirm the keeper still recreates it (no regression).

### Layer 3 — Visual review

n/a — no renderer UI is touched.

## Design notes

- **Contracts changed:**
  - `parseSlackContext(url) → { teamId, channelId }` — the legacy-subdomain fallback narrows from "any non-`app` `*.slack.com` subdomain" to a real workspace subdomain (single label, not a Slack-owned reserved host). `acme.enterprise.slack.com` is a Slack *Enterprise Grid sign-in host*, not a workspace.
  - `upsertWorkspace(registry, entry, now)` — validates the id and canonicalizes the URL before persisting.
- **New modules:** none. New pure exports on `core/slack-workspaces.js`: `isTeamId`, `canonicalWorkspaceUrl`, `pruneRegistry`, plus `hasBrokenSlackSession(targets)` feeding `planParkedTabs`.
- **New ADR needed?** no — a correctness fix inside ADR-0011's keeper (t070/t098), not a new decision.

```ts
isTeamId(id: string): boolean                       // ^[TE][A-Z0-9]{6,}$
canonicalWorkspaceUrl(teamId: string): string       // https://app.slack.com/client/{teamId}
pruneRegistry(registry: Registry): Registry         // drops non-team keys, canonicalizes urls
hasBrokenSlackSession(targets: Target[]): boolean   // a *.slack.com page with no /client/{team}
planParkedTabs(registry, live, createdAt, now, pinUrlByTeam, brokenSession): Plan[]
```

## Out of scope

- Reducing the keeper to a single cred-lifeline tab for all workspaces (one live Slack tab already refreshes every workspace's creds, so per-workspace parked tabs are arguably unnecessary). Tempting, but it would push non-live workspaces' capture latency onto the 15s sweep backstop and lose their hijack "sweep now" trigger. Separate task if wanted.
- Auto-recovering a dead Slack SSO session. Out of reach — the user re-authenticates.
- Pruning workspaces not seen for N days.

## Definition of Done

- [x] Layer 1 tests written and green
- [ ] Layer 2 smoke checklist completed against the live Remote Browser — pending deploy
- [x] Layer 3 — n/a
- [x] `pnpm check:changed` clean
- [x] `pnpm typecheck` clean
- [x] `pnpm test` green
- [x] CLAUDE.md updated for any modified module
- [x] Task closed: status → done, file moved to `docs/tasks/done/`, t104 in commit

## Notes

Live evidence (2026-07-13, `100.x.x.x:9222`):

```
F8522919 | https://acme.enterprise.slack.com/?sso_failed=1        ← invalid, keeps returning
A695BFE1 | https://app.slack.com/client/E0761H36LHY/D0AV4KK2CH2  ← Grid org (pseudo-team, t092)
BCCAA981 | https://app.slack.com/client/T01CDUT3CBD/C01CSBTB8DP  ← Acme workspace
```

Chain: Grid SSO session dies → keeper recreates `app.slack.com/client/E0761H36LHY/…` → Slack redirects to `acme.enterprise.slack.com/?sso_failed=1` → keeper registers that landing page as workspace `acme.enterprise` with its error URL → the fake workspace never has a live tab → recreated forever.

**Loop reproduced live (pre-fix server, 2026-07-13):** closed the `?sso_failed=1` tab; it was back 36s later. Worse than modeled — the keeper also spawned duplicate `E0761H36LHY` and `T01CDUT3CBD` client tabs in the same burst (3 page targets → 7). The `brokenSession` stand-down covers that too: with a sign-in landing page open, the keeper now creates nothing.

---

_When task status flips to `done`, move this file to `done/`._
