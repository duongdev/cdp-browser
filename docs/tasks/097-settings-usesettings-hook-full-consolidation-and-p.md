# 097 — settings: useSettings hook full consolidation + prop-drill reduction

- **Status:** draft
- **Mode:** HITL
- **Estimate:** 1d
- **Depends on:** none
- **Blocks:** none

## Goal

Spillover from t096 (A3). The dual `getUiState()` load inside `settings-dialog.tsx`
was already merged to one (t096). This task takes the **larger, visual-review-gated**
half: a single `useSettings` hook (or equivalent) that owns the ui-state load + writes
shared between `app.tsx` and `settings-dialog.tsx`, and reduces the ~28-prop
`app.tsx → Toolbar → SettingsDialog` pass-through.

## Why now

Deferred from t096 because it (a) **de-localizes** settings that are currently
appropriately co-located with their UI — so it must be done as a deliberate locality
trade, not a blind sweep (see ADR-0015); and (b) touches the settings dialog across
many cards, so it **requires Layer-3 visual review** (all cards still load + persist
correctly) which the AFK t096 run could not perform.

## Acceptance criteria

- [ ] A single ui-state load owner shared by `app.tsx` + `settings-dialog.tsx`
      (no component runs an independent `getUiState` for a setting another owns).
- [ ] `slackExcludes` has one owner — the dialog reads it from the shared source
      rather than caching its own copy (removes the open-while-muted stale window).
- [ ] The `app → Toolbar → SettingsDialog` prop chain is materially reduced.
- [ ] Partial-merge writes preserved; **no** save-queue / offline machinery
      (rejected as over-engineering in t096 — no observed lost-write or offline bug).
- [ ] Layer-3 visual review: every settings card loads its current value and
      persists on change (host/port, theme, adaptiveViewport, quality tier, mutes,
      excludes, webPush, virtual pointer).

## Notes

t096 evidence (verifier A3, corrected): the real defect was the dual load (fixed in
t096) + the duplicate `slackExcludes` owner. `app.tsx` and `settings-dialog.tsx` own
mostly-disjoint settings; the overlap (`slackExcludes`) self-heals on dialog reopen
because app.tsx reads it on-demand. So this is a **locality + ergonomics** refactor,
not a correctness fix — scope it accordingly.

---

_When task status flips to `done`, move this file to `done/`._
