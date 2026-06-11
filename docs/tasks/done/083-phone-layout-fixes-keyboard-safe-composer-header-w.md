# 083 — phone layout fixes: horizontal overflow, keyboard-safe composer, header wrap

- **Status:** done
- **Mode:** HITL
- **Estimate:** 0.5d
- **Depends on:** 076, 077, 078, 082
- **Blocks:** none

## Goal

Fix three phone-shell layout bugs found in HITL: (1) notification rows ran off the right edge because the Inbox/reader/switcher panels were flex children without `min-w-0`, so they grew wider than the viewport and text wrapped at the off-screen edge; (2) the reply composer was hidden behind the iOS software keyboard; (3) long workspace names pushed the unread count and row controls off-screen.

## Acceptance criteria

- [x] Inbox/reader/switcher roots get `min-w-0` + `overflow-x-hidden` — no horizontal overflow at 390px (verified: documentElement.scrollWidth == innerWidth with a long Azure-URL message).
- [x] Message bodies break long tokens (`break-words` + `overflow-wrap:anywhere`).
- [x] Group headers are two lines (conversation / workspace) so a long workspace name can't shove the count or controls off-screen.
- [x] Viewport meta gains `interactive-widget=resizes-content`; `app-height` tracks `visualViewport.height` so the body shrinks for the keyboard and the bottom-anchored composer stays visible.

## Test plan

Layer 1: n/a (CSS + meta). Layer 3: verified on the harness (no overflow) and on-device (user confirmed overflow fixed).

## Notes

The real cause of the "text wrap" report was horizontal overflow from a missing `min-w-0` on the flex panel — `break-words` alone didn't help because the container itself was wider than the screen. Unsweepable-workspace reply + on-screen keyboard for the screencast are separate follow-ups (t084+).

---

_When task status flips to `done`, move this file to `done/`._
