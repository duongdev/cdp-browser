# 018 — iPad workday verification

- **Status:** ready
- **Mode:** HITL
- **Estimate:** 1d
- **Depends on:** 015, 016, 017, 048, 049, 051, 061
- **Blocks:** none

## Goal

One full workday using the iPad PWA exclusively for remote browsing (Teams chat, Outlook mail, navigation, tab switching) with Magic Keyboard trackpad input and landscape orientation. Verify that the user would want to use this app on iPad — no "open Mac to use this feature" moments, screencast renders smoothly, input is responsive, Web Push notifications arrive on lock screen, sidebar doesn't feel cramped, settings persist, and overall feel is daily-driver quality per product.md.

## Why now

This is the final gate before v1 is declared done. Tasks 015, 016, and 017 supply the foundation; this task confirms it actually works in practice and identifies any last-minute polish needed.

## Acceptance criteria

- [ ] iPad Pro 11" or 13" with Magic Keyboard; connected to the same remote browser as your Mac
- [ ] Install the web build as a PWA (Add to Home Screen) on the iPad
- [ ] Use exclusively for one full workday (8+ hours, or equivalent real usage across multiple sessions)
- [ ] Tasks attempted: Teams chat (read, reply, search), Outlook mail (read, navigate, reply), browsing (navigation, form input, scrolling), tab switching (sidebar navigation, reordering if applicable)
- [ ] Each task completes without returning to Mac (no "I'll just use the Mac instead" moments)
- [ ] Trackpad input responsive and accurate (no lag, no offset clicks)
- [ ] Screencast frame rate stable (no stuttering; responsive to scrolling)
- [ ] Notifications arrive on lock screen; clicking them deep-links to the conversation
- [ ] Sidebar at 180px width doesn't feel cramped; interactive targets are easily tappable
- [ ] One session held entirely by FINGER (no Magic Keyboard, couch use): finger drag scrolls the remote page, a tap clicks at the correct coordinates, a long-press opens the context menu (via t051 touch-scroll-tap); the settings drawer is dismissable by touch (t049); all interactive targets are comfortably tappable at >=44pt (t048)
- [ ] Settings persist across app close/reopen (theme, pins, sidebar width, notification toggle)
- [ ] E2E mode, if enabled, passphrase entry works smoothly; encryption doesn't break push
- [ ] Authentik session survives app close and PWA install (stay logged in)
- [ ] If any blocking issue emerges, capture as a follow-up task (don't block this task's closure)

## Test plan

### Layer 1 — Pure logic

n/a — this is manual user testing.

### Layer 2 — Manual smoke

n/a — this is the full verification pass.

### Layer 3 — Visual review

- [ ] Screenshots of iPad home screen showing installed app icon and name
- [ ] Screenshots of iPad in landscape showing Teams chat, Outlook mail, and general browsing
- [ ] Screenshot of lock screen with notification visible
- [ ] Screen recording (30s) of tab switching and trackpad interaction to show responsiveness

## Design notes

No code changes expected. This is a verification-only task. If issues are found, document them here and create follow-up tasks (do not fix in-place; close this task and log the blockers).

## Out of scope

- Fixing bugs or UX issues found — those become separate follow-up tasks
- Optimizing performance beyond task 017 (Web Push) — performance work is separate
- Testing on non-iPad devices (only iPad target)

## Definition of Done

- [ ] One full workday of real usage logged (date + duration in Notes)
- [ ] No blocking issues (issues documented as follow-ups, not blockers)
- [ ] Screenshots + screen recording captured and committed
- [ ] Notes section summarizes the user experience: what felt right, what felt wrong, what surprised you
- [ ] If any follow-up task is needed, a new docs/tasks/NNN-*.md is created and linked below
- [ ] `pnpm check` clean (Biome)
- [ ] `pnpm typecheck` clean
- [ ] Task closed: status → done, file moved to `docs/tasks/done/`, t018 in commit

## Notes

**Workday log:**
- [ ] Session 1: date, time, duration, tasks attempted, notes
- [ ] Session 2: date, time, duration, tasks attempted, notes
- …

**Experience summary (fill after workday):**
- Smooth parts:
- Rough parts:
- Surprises:

**Follow-up tasks created:**
- [ ] (link to any t0NN filed during verification)

---

**Phase 2 trigger conditions:** If Web Push proves unreliable (notifications lost, silent failures) or if keyboard shortcuts become critical daily pain, Phase 2 Capacitor wrapper is warranted. Otherwise, PWA is the supported model.

---

_When task status flips to `done`, move this file to `done/`._
