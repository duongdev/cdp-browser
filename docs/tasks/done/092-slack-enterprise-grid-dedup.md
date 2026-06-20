# 092 — dedup Enterprise Grid org against its workspaces

- **Status:** done
- **Mode:** HITL
- **Estimate:** 1d
- **Depends on:** none
- **Blocks:** 093

## Goal

In an Enterprise Grid, Slack registers the **org itself** as a pseudo-team (an `E…`-prefixed id) *alongside* its member workspaces, and the org token surfaces the same channels the member workspace does. The Slack Content Sweep treats every team in `localConfig_v2` as an independent capture target and keys entries `slack:{teamId}:{channel}:{ts}`, so a message in a channel reachable from both the org and a workspace is captured **twice** (different team prefix → different id → the `ingest` id-dedup can't catch it). The user sees duplicate notifications and two near-identical health rows. After this task, all teams sharing an `enterprise_id` collapse to **one logical workspace** keyed `slack:{groupId}` (`groupId = enterprise_id || teamId`): the same message dedups for free, and the health/mute UI shows one row per org. Physical identity (tabs, parked-tab keeper, deep-link target) stays per-`teamId`.

## Why now

This is a live bug on the daily-driver PWA: every message in 27 Example channels currently fires two notifications and two web-pushes. It also simplifies t093's per-device mute list (one "Example Group" row instead of two). It can't wait — the duplication is visible and annoying on every Example message.

Evidence captured live against `<remote-browser-host>:9222` (the Example remote browser):

```
team          name                            src            convos
E0EXAMPLE01   Example Group Holdings Limited   client.counts    27   (enterprise_id: null → IS the org)
T0EXAMPLE01   Example Group                    users.counts     51   (enterprise_id: E0EXAMPLE01)
T0EXAMPLE02   Example-Team                     client.counts    22   (enterprise_id: null → standalone)

OVERLAP org∩ws  = 27   ← all 27 org channels are also in the workspace
OVERLAP org∩dcp = 0    ← Example-Team genuinely separate
OVERLAP ws∩dcp  = 0
```

The org pseudo-team is a 27-channel **subset** of the (API-restricted) workspace. Neither alone is complete (org has the richer `client.counts` watermarks for its 27; the workspace has all 51 but degraded `users.counts`), so the obvious "drop one" fix is lossy — hence dedup-by-merge rather than delete.

## Acceptance criteria

- [ ] `groupId(cred)` returns `enterprise_id` when present, else `teamId` (pure, tested).
- [ ] A message present under both the org pseudo-team and a member workspace yields **exactly one** notification entry (dedup by `slack:{groupId}:{channel}:{ts}`).
- [ ] Each entry retains a concrete `teamId` field so activation / SPA deep-link still opens the channel in a real workspace.
- [ ] `/api/notifications/health` returns one row per `groupId`: Example shows a single row, Example-Team a separate row.
- [ ] `slack-workspaces.json` persists `enterpriseId` per workspace (was `{teamId,url,name,lastSeen}`).
- [ ] A Slack tab/pin's unread badge resolves to the merged `slack:{groupId}` bucket (renderer aggregator fed a `teamId → groupId` map).
- [ ] Existing `slackExcludes` entries keyed by the old `teamId` are migrated to `groupId` on load; channel mutes still apply after the merge.
- [ ] Example-Team (`enterprise_id` null) is unchanged: `groupId === teamId`, one row, no behavior change.

## Test plan

### Layer 1 — Pure logic (TDD)

- [ ] `groupId(cred)` — enterprise_id present → returns it; absent/empty → teamId.
- [ ] Sweep reducer / runner ingest — two sibling teams (same enterprise) emitting the same `(channel, ts)` produce one entry; distinct channels both retained; a standalone team unaffected.
- [ ] `unread-aggregator` `slackGroupKey` — with an injected `teamId → groupId` map, two Slack tabs of the same org bucket into one group; without a mapping entry, falls back to `slack:{teamId}` (today's behavior).
- [ ] `slack-excludes` migration — a list keyed by old teamId is re-keyed to groupId via the map; idempotent on re-run; non-Grid entries untouched.
- [ ] `notification-health` grouping — N member creds + 1 org cred → one row; label + status aggregation rules.

### Layer 2 — Manual smoke (CDP/IPC)

- [x] `CDP_HOST=<remote-browser-host> node web/server.mjs` → `/api/notifications/health` returns `{ rows, groups }` with **two** rows: one "Example Group" (groupId `E0EXAMPLE01`, teams `[E0EXAMPLE01, T0EXAMPLE01]`) + a separate "Example-Team" (was three rows). `groups` map: `T0EXAMPLE01 → E0EXAMPLE01`. Verified live 2026-06-19.
- [x] Entry keying: org + member-workspace sweeps now stamp the same `slack:{groupId}` id for a shared `(channel, ts)` → `ingest` dedups → one entry (covered by `slack-sweep-runner.test.ts` + the live merged `groups` map).
- [x] Deep-link preserved: entry keeps concrete `teamId` (`slack-sweep-runner.test.ts` asserts `/client/{teamId}/{channel}`).
- [ ] HITL: observe a real message in a shared Example channel fire exactly one push on a device (needs a live message; flagged for your return).

### Layer 3 — Visual review

- [ ] Deferred to HITL — no debug Chrome in the AFK env. The endpoint is verified (`rows`/`groups`) and `settings-dialog.tsx` reads `data.rows`; the card will render one Example row. Capture on next desktop session.

## Design notes

- **Contracts changed:**
  - Slack notification entry — gains/keeps a concrete `teamId` (workspace of capture) **and** `groupKey = slack:{groupId}`; the entry **id** is derived from `groupKey` so `ingest`'s id-dedup collapses org+workspace duplicates.
  - Slack workspace registry record — `{ teamId, url, name, lastSeen }` → adds `enterpriseId`.
  - `/api/notifications/health` row — keyed by `groupId`, carries `enterpriseId`; one row per org. The renderer also receives the `teamId → groupId` map (from the registry/health payload) to resolve tab/pin badges.
  - `slack-excludes` — exclude entries re-key `team` → `groupId`; a one-time load migration converts persisted lists.
- **New helpers:** `groupId(cred)` (pure, server side — `enterprise_id || teamId`); a `teamId → groupId` map builder distributed to the renderer. No new module if these fit existing `core/slack-*` files.
- **New ADR needed?** No — extend **ADR-0011** with a Grid-grouping note (sweep keys by enterprise group, physical identity stays per-team). `enterprise_id` is already parsed by `core/slack-creds.js` `parseLocalConfig`; it just isn't persisted or used yet.

```ts
// grouping key — physical teamId stays for tabs/deep-link, grouping moves to groupId
type SlackCred = { teamId: string; enterpriseId?: string; /* … */ }
const groupId = (c: SlackCred) => c.enterpriseId || c.teamId

// entry: dual-keyed
type SlackEntry = {
  teamId: string          // concrete workspace — activation / /client/{teamId}/{channel}
  groupKey: string        // `slack:${groupId}` — dedup + unread bucket + health + mute
  channelId: string
  ts: string
  // id derived from groupKey+channel+ts → ingest dedups org vs workspace for free
}
```

## Out of scope

- Per-device notification mutes — that's **t093** (this task only fixes the duplicate + collapses the rows it will list).
- Optimizing the double-fetch of the 27 shared channels — both tokens still sweep; dedup makes it correct, not efficient. Accept for v1; optimize later if it costs.
- UX for an enterprise with **multiple genuinely-distinct** member workspaces — the rule merges *all* teams of one `enterprise_id` into one row. Example has one real member workspace + the org pseudo-team, so it's correct here; revisit if a user has 2+ distinct member workspaces they want listed separately.
- Merged-row **label** rule is a small choice (friendlier member name "Example Group" when present, else org name) — implement the recommendation; not a separate task.

## Definition of Done

- [x] Layer 1 tests written and green (844 unit tests; new coverage for groupId/dedup/health-merge/aggregator-map/excludes-migration/read-sync)
- [x] Layer 2 smoke completed against the live Example remote browser (health endpoint merges to one Example row)
- [ ] Layer 3 health-card screenshot captured — deferred to HITL (no debug Chrome AFK)
- [x] `pnpm typecheck` clean, `pnpm test` green, `pnpm test:e2e` green; Biome 0 errors on touched files (pre-existing warnings only)
- [x] `node web/server.mjs` boots and the Example rows collapse end-to-end
- [x] CLAUDE.md + `src/lib/CLAUDE.md` + ADR-0011 note updated for the changed modules
- [x] No debris, no AI attribution
- [x] Task closed: status → done, moved to `docs/tasks/done/`, `t092` in branch + commit

## Notes

Root cause + fix decided in a grilling session (2026-06-19). The user's "they're the same and duplicated" was correct: org `E0EXAMPLE01` ⊂ workspace `T0EXAMPLE01` (27 shared channels). Chose merge-by-`enterprise_id` over cross-dedup-keeping-rows and over drop-a-team (latter is lossy because the member workspace is API-restricted).

---

_When task status flips to `done`, move this file to `done/`._
