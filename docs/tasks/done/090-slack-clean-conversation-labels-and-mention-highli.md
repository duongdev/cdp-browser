# 090 — slack clean conversation labels and mention highlight

- **Status:** done
- **Mode:** HITL
- **Estimate:** 0.5d
- **Depends on:** 082
- **Blocks:** none

## Goal

Slack group headers read as the conversation itself — `#channel` for channels/threads, `@person` for a DM, `@a, b, c` for a group DM — dropping Slack's "New message in/from" prefix. And messages that @-mention the viewer are highlighted so they stand out from ambient channel/DM traffic.

## Acceptance criteria

- [x] Group header (inbox + bell) + reader title show the clean `#`/`@` label.
- [x] DM, group DM, and thread conversations each get the right sigil.
- [x] Mentioned entries get a left accent bar + tint + `@you` badge.
- [x] Works for both swept entries (structured) and older hijack entries (parse Slack's title).

## Test plan

### Layer 1 — Pure (TDD)
- [x] `slackGroupLabel` — swept (#/@/group-DM) + hijack title parsing; `slackIsMention` — swept flag + hijack heuristic (`notifications-view.test.ts`).

### Layer 3 — Visual
- [x] Harness: `#team-prs`, `@Jordan Lee` headers; `@you` badge on the mention entry.

## Design notes

- **Contracts changed:** sweep entries gain `slackConvo` (resolved conversation name) + `slackMention` (from `isMention`). `core/slack-sweep.js` + `decorate` in the runner stamp them; `ViewEntry` carries them.
- **New modules:** none — `slackGroupLabel`/`slackIsMention` join the other pure helpers in `notifications-view.ts`.
- **New ADR needed?** no.

## Notes

DMs are not "mentions" — only @-mentions (direct, @here/@channel/@everyone, or a subteam) highlight, matching Slack's own model. Group-DM raw `mpdm-a--b--c-1` names are prettified to `a, b, c`.

---

_When task status flips to `done`, move this file to `done/`._
