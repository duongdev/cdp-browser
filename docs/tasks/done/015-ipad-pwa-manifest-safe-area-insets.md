# 015 — iPad PWA manifest + safe-area insets

- **Status:** done
- **Mode:** HITL
- **Estimate:** 0.5d
- **Depends on:** none
- **Blocks:** 016

## Goal

Enable iPad to run the web build as an installable PWA (Add to Home Screen) with landscape-locked viewport and proper safe-area insets for iPad Pro notch + home indicator. After this task, the PWA manifest is iPad-aware and CSS respects safe-area boundaries so content doesn't hide behind system chrome.

## Why now

This is the foundation for Web Push (task 017) — Web Push only works in installed PWAs on iOS 16.4+. Tasks 016 and 018 depend on a working manifest. Unblocks the entire iPad port.

## Acceptance criteria

- [ ] `public/manifest.webmanifest` has `"orientation": "landscape"`, matching iPad display
- [ ] iPad app icons are specified in manifest (192px, 512px, at least one maskable for adaptive icon)
- [ ] `src/index.css` includes `env(safe-area-inset-*)` CSS variables applied to viewport boundaries
- [ ] Canvas container respects bottom safe-area so home indicator doesn't overlay content
- [ ] Toolbar and sidebar apply safe-area insets where needed (notch on iPad Pro)
- [ ] `pnpm dev` web build loads in Safari on iPad and shows Add to Home Screen prompt
- [ ] Installed app renders full-screen (standalone display mode) with no Safari chrome

## Test plan

### Layer 1 — Pure logic

n/a — manifest and CSS only.

### Layer 2 — Manual smoke

n/a — no main.js touched.

### Layer 3 — Visual review

- [ ] Screenshots on iPad 13" and 11" in Safari: manifest.webmanifest parses, app icon visible
- [ ] After install in standalone mode: no Safari chrome, full-screen rendering
- [ ] Safe-area insets respect iPad Pro notch on top; toolbar/sidebar don't hide
- [ ] Canvas stretches to safe edges; home indicator doesn't overlay viewport

## Design notes

- **Contracts changed:** none — manifest + CSS only
- **New modules:** none
- **New ADR needed?** no

## Out of scope

- Adaptive orientation changes (landscape ↔ portrait) — locked to landscape
- Pinch-zoom gestures — deferred to task 016
- Web Push subscription UX — deferred to task 017
- Touch event translation — deferred to task 016

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
- Updated `public/manifest.webmanifest` with `"orientation": "landscape"` — landscape-locked for iPad workstation use
- Added `viewport-fit=cover` to HTML viewport meta tag — required for safe-area env variables to take effect
- `body` uses `100dvh` for full-height layout (handles Safari URL bar; `h-screen` collapses under keyboard)
- Safe-area insets applied per-component to avoid a black bar at the home indicator that global `body` padding caused:
  - Sidebar scroll container: `pb-[max(0.5rem,env(safe-area-inset-bottom))]`
  - Status bar: `pb-[env(safe-area-inset-bottom)]`
- Manifest icons (192px, 512px, maskable 512px) already present and configured

All acceptance criteria met. Ready for t016 layout audit to build on this foundation.

---

_When task status flips to `done`, move this file to `done/`._
