# 091 — highlight slack DMs as directed-at-you

- **Status:** done
- **Mode:** HITL
- **Estimate:** 0.1d
- **Depends on:** 090
- **Blocks:** none

## Goal

t090's mention highlight only fired for channel @-mentions, so a DM (which is inherently
directed at you, and often @-names you in the body) was left unhighlighted. Broaden the
highlight to cover DMs / group DMs as well as channel mentions.

## Acceptance criteria

- [x] `slackIsMention` returns true for `slackKind` im/mpim regardless of the flag.
- [x] Hijack DM titles ("New message from X") highlight.
- [x] Channel mentions still highlight; non-Slack never.

## Test plan

### Layer 1 — Pure
- [x] `slackIsMention` — DM/group-DM directed-at-you; hijack DM + channel both highlight (`notifications-view.test.ts`).

## Notes

Teams has NO mention highlight and can't easily — its toast capture (inject/teams-notify.js)
grabs only source/title/body text with no @-mention signal. A Teams mention highlight would
need adapter-specific capture work (separate task if wanted).

---

_When task status flips to `done`, move this file to `done/`._
