# 082 — show workspace and conversation kind on notifications

- **Status:** done
- **Mode:** HITL
- **Estimate:** 0.5d
- **Depends on:** 077
- **Blocks:** none

## Goal

A notification answers "where did this arrive?" at a glance: the Inbox and bell-popover group headers show the Slack **workspace name** next to the conversation label, DMs/group-DMs are labeled as such (channels are self-evident from the `#` in the title), and a thread reply carries a thread marker on its row. The Conversation Reader header shows the workspace under the title. Multi-workspace users (3+ live workspaces) can no longer confuse two same-named channels or DMs across workspaces.

## Why now

User request after first multi-workspace test: "I need to know exactly where the messages arrive — which workspace, which channel/thread/DM." The data already rides every swept entry (`source` = workspace name, `slackKind`, `slackThreadTs`); this is presentation only.

## Acceptance criteria

- [ ] Inbox group header: conversation label + workspace name (muted) for Slack entries; DM / Group DM labeled.
- [ ] Bell popover group header: same context, desktop density.
- [ ] A thread reply row shows a thread marker.
- [ ] Reader header shows the workspace under the conversation title (Slack only).
- [ ] Non-Slack entries unchanged (Teams/Outlook already self-identify via icon + source).

## Test plan

### Layer 1 — Pure logic (TDD)

- [ ] `slackGroupMeta(items)` — workspace + kind (dm/group-dm/channel) from the group's entries; null for non-Slack.

### Layer 2 — Manual smoke (CDP/IPC)

n/a — presentation only.

### Layer 3 — Visual review

- [ ] Inbox groups across two workspaces show distinct workspace names; DM badge visible.

## Design notes

- **Contracts changed:** none — `ViewEntry` already carries `source`/`slackKind`/`slackThreadTs`.
- **New modules:** none — `slackGroupMeta` joins the other pure helpers in `notifications-view.ts`.
- **New ADR needed?** no.

## Out of scope

- Structured channel-name field (the title already embeds `#channel`).
- Workspace filtering/sections in the Inbox.

## Definition of Done

- [ ] Layer 1 tests green
- [ ] Layer 3 verified
- [ ] `pnpm typecheck` / `pnpm test` green
- [ ] CLAUDE.md consistent
- [ ] Task closed: status → done, moved to `done/`, t082 in commit

## Notes

Closure notes: `slackGroupMeta` (notifications-view.ts, 3 tests); Inbox + bell group headers show "{workspace} · DM/Group DM" (channels show workspace only — the # is already in the label); thread replies get a "↳ thread" marker on Inbox rows; reader header gains a workspace/kind subtitle. Verified live against the user's 3 real workspaces on :7801.

---

_When task status flips to `done`, move this file to `done/`._
