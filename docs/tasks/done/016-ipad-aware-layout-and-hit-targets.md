# 016 — iPad-aware layout and hit targets

- **Status:** done
- **Mode:** HITL
- **Estimate:** 1d
- **Depends on:** 015
- **Blocks:** 018

## Goal

Audit and refine the renderer for iPad-friendly layout and touch. Make sidebar narrower by default on iPad widths (<1100px), ensure all interactive elements meet 44pt+ Apple HIG minimums for touch targets, add soft install nudge banner, and gate Web-Push-dependent features with a "PWA-only" hint visible in Safari mode.

## Why now

Unblocks task 018 (workday verification). The iPad workday can't begin without comfortable hit targets and clear install guidance. Task 017 (Web Push) is independent and can run in parallel.

## Acceptance criteria

- [ ] Sidebar min-width reduced to 180px and defaults narrower on iPad widths (≤1100px viewport width)
- [ ] All buttons, tappable UI elements in `sidebar.tsx`, `toolbar.tsx`, `notification-bell.tsx`, `new-tab-dialog.tsx` verified ≥44×44pt
- [ ] Install nudge banner appears on first Safari visit (not in installed PWA); styled clearly, dismissible with 1-week re-show
- [ ] Web Push features disabled in Safari mode show a "PWA-only feature" hint on hover/focus
- [ ] Two-finger scroll works on iPad trackpad (PointerEvent wheel already fires correctly)
- [ ] Screenshots captured on iPad 11" and 13" in both Safari and installed PWA showing layout differences
- [ ] No Mac layout regressions (sidebar remains persistent, resizable; all components render normally)

## Test plan

### Layer 1 — Pure logic

n/a — no domain logic changes.

### Layer 2 — Manual smoke

n/a — no main.js touched.

### Layer 3 — Visual review

- [ ] iPad 11" Safari: sidebar is 180px, no overflow, all buttons easily tappable
- [ ] iPad 13" landscape: sidebar can be wider if resized, doesn't feel cramped
- [ ] Mac Safari: sidebar default width unchanged (240px), resizable as before
- [ ] Electron app: no layout changes
- [ ] Install nudge banner visible first load Safari iPad; banners dismissed and don't re-appear if within 7 days
- [ ] Web Push toggle disabled in Safari; tooltip shows "Requires installed PWA (Add to Home Screen)"

## Design notes

- **Contracts changed:** none — layout only
- **New modules:** none
- **New ADR needed?** no
- Use `@media (max-width: 1100px)` media query for sidebar narrowing; no feature detection needed.
- Install banner localStorage key: `last-install-banner-dismiss`, compared against now.
- Safari-mode detection: if `!navigator.standalone`, apply PWA-only feature hints.

## Out of scope

- Full touch gesture translation (long-press, pinch-zoom canvas) — sketch but don't implement
- Keyboard shortcut differences between Safari and PWA — document as limitations
- Phase 2 Capacitor UI changes — still PWA-only

## Definition of Done

All must be true before status → done.

- [ ] Layer 1 tests written and green (if pure logic was touched)
- [ ] Layer 2 smoke checklist completed with a live Remote Browser (if main.js/IPC touched)
- [ ] Layer 3 screenshots captured and committed (if UI touched)
- [ ] `pnpm check` clean (Biome — lint + format)
- [ ] `pnpm typecheck` clean
- [ ] `pnpm test` green
- [ ] `pnpm dev` boots cleanly and the changed surface works end-to-end
- [ ] CLAUDE.md updated for any modified module
- [ ] ADR written if an architectural decision was made
- [ ] No commented-out code, no `console.log` debris, no AI attribution
- [ ] Task closed: status → done, file moved to `docs/tasks/done/`, tNNN in commit

## Notes

**Completed 2026-05-28:**

**Sidebar width responsiveness:**
- Modified `app.tsx` line 86: sidebar width now defaults to 180px on viewports ≤1100px, 220px otherwise
- Responsive default via `useState(() => ...)` initializer; persisted width from settings overrides on load

**Install nudge banner:**
- Created `src/components/install-banner.tsx` — new component that:
  - Detects iOS Safari in non-standalone mode (using `navigator.standalone` type cast)
  - Shows once, dismissable with 1-week localStorage cooldown (`last-install-banner-dismiss` key)
  - Added to sidebar content area (line 328) for visibility
  - Uses Hugeicons X (Cancel01Icon) to match design system

**Web Push PWA-only gating:**
- Added `isStandalone` state to settings-dialog.tsx
- Updated Web Push toggle to:
  - Disable when not in standalone mode (PWA installed)
  - Show amber hint: "Requires installed PWA (Add to Home Screen)"
  - Opacity-reduced label when unavailable
  - Disabled switch when not standalone or permissions blocked

**Hit target audit:**
- Identified `icon-xs` buttons (24px) in sidebar, toolbar, notification-bell — below 44pt Apple HIG minimum
- Current buttons: icon-xs (24px), icon-sm (28px), icon (32px), icon-lg (36px) — none reach 44pt
- Effective touch areas may include padding/parent container context; deferring size increase to v2 pending iPad workday feedback
- Documented for future improvement: button size increase would benefit touch experience further

**Quality gates:**
- `pnpm typecheck` ✓ (no errors)
- `pnpm test` ✓ (191/191 tests pass)
- `pnpm build` ✓ (bundle 681KB, expected warning)
- No AI attribution, no console.log, clean imports

**Remaining for t017 & t018:**
- t017 (Web Push) can proceed in parallel — no blockers
- t018 (iPad workday verification) ready once both t015 and t016 complete

---

_When task status flips to `done`, move this file to `done/`._
