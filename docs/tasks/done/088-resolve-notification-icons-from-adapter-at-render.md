# 088 — resolve notification icons from adapter at render time

- **Status:** done
- **Mode:** HITL
- **Estimate:** 0.25d
- **Depends on:** 086
- **Blocks:** none

## Goal

Slack notification icons still didn't show after t086: the stored entries are old persisted hijack entries whose `icon` field was baked at capture time with the now-blocked external slack-edge URL, and t086 only changed the icon for NEW entries. Fix: resolve the icon from the entry's adapter at render time so every entry — old persisted or new — uses the bundled same-origin icon.

## Acceptance criteria

- [x] `iconForEntry(entry)` maps known adapters (teams/outlook/slack) to `/icons/*.svg`, ignoring a stale stored URL; falls back to the stored icon for unknown adapters.
- [x] Group headers (inbox + bell) and the reader header use it.
- [x] Verified: a slack-adapter entry renders the local slack.svg regardless of its stored icon.

## Test plan

### Layer 1 — Pure (TDD)
- [x] `iconForEntry` — known adapters → local path even with a stale stored URL; unknown → stored; null → undefined (`notifications-view.test.ts`).

### Layer 3 — Visual
- [x] Harness: slack-adapter entries render slack.svg (naturalWidth > 0).

## Notes

Render-time resolution (not the stored value) is the durable fix because the store persists across builds — a one-time migration would still leave stale URLs from any future capture-time mistake.

---

_When task status flips to `done`, move this file to `done/`._
