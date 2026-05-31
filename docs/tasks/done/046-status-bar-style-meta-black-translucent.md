# 046 — apple status-bar-style black-translucent meta

- **Status:** done
- **Mode:** HITL
- **Slice:** 2-ipad-shell
- **Ring:** inner
- **Estimate:** 0.5d
- **Depends on:** landscape-safe-area-top-left-edges
- **Blocks:** none

## Goal

Make the installed iPad PWA fill the whole screen edge-to-edge with native chrome instead of looking like a framed webpage. Today `index.html` declares `apple-mobile-web-app-capable` (standalone display) and `viewport-fit=cover`, but it has no `apple-mobile-web-app-status-bar-style`, so iOS draws an opaque default status bar that sits as a solid strip above the app. After this task the page declares `<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">`, so the iOS status bar becomes translucent and the web view extends underneath it — the toolbar/background bleed to the very top edge for a native, full-bleed daily-driver feel.

## Why now

The web PWA is the v0.1.0 release surface, and "looks like a native app, not a framed webpage" is a daily-driver bar for the iPad shell (Slice 2, inner ring — must close before tagging v0.1.0). This is a one-line meta change and the cheapest possible polish win, but it has a hard ordering constraint: `black-translucent` makes app content render *under* the status bar, so the top safe-area inset must already protect content from being clipped. That protection is t045 (`landscape-safe-area-top-left-edges`), so this task lands after it. Without t045 first, switching to translucent would push the toolbar under the clock/battery. This is checked under the t018 iPad workday verification gate.

## Acceptance criteria

- [ ] `index.html` `<head>` contains `<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">`.
- [ ] The existing `apple-mobile-web-app-capable`, `viewport-fit=cover`, and `theme-color` meta tags are unchanged (the status-bar style only takes effect alongside standalone capability + `viewport-fit=cover`).
- [ ] In the installed standalone PWA on iPad, the status bar is translucent and the app background extends to the very top edge (no opaque strip above the toolbar).
- [ ] App content is **not** clipped under the translucent status bar — the top safe-area inset from t045 keeps the toolbar fully visible (relies on t045 being landed first).
- [ ] No behavior change in a Safari browser tab (non-standalone) — the meta is a no-op there.
- [ ] No change to the Electron build (the meta only affects iOS standalone web views).

## Test plan

### Layer 1 — Pure logic (TDD)

n/a — this task only adds a static HTML meta tag; no pure logic touched.

### Layer 2 — Manual smoke (CDP/IPC)

n/a — no main-process, IPC, or web-server code touched.

### Layer 3 — Visual review

- [ ] Desktop-web sanity via Chrome MCP against `pnpm dev` (or the built `dist/`): confirm the page still loads and the four states (loading / empty / error / populated) render unchanged — the meta has no desktop effect, so this is a no-regression check.
- [ ] iPad-physical (HITL, flagged for t018): install the PWA to the Home Screen, launch standalone, screenshot — the status bar is translucent, the background reaches the top edge, and the toolbar is not clipped under the clock/battery.
- [ ] iPad-physical (HITL): confirm a plain Safari-tab visit (not installed) is visually unchanged.

## Design notes

Behavioral change, not a path walk:

- **`index.html`** — add one `<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">` line in `<head>`, alongside the existing `apple-mobile-web-app-capable` meta. This is the only edit. `black-translucent` is chosen over `default`/`black` because it lets the app's own dark background show through the status bar (matching `theme-color="#0a0a0a"`) for a seamless full-bleed look; `default`/`black` reserve an opaque strip and defeat the edge-to-edge goal.

- **Contracts changed:** none — static HTML meta only.
- **New modules:** none.
- **New ADR needed?** no — this is a small iPad-shell polish detail implied by the locked v0.1.0 plan (web PWA = release surface; iPad-targeted manifest already recorded). It extends the safe-area work in done t015 and t045; no new architectural decision.

This pairs with the safe-area insets already applied per-component (sidebar scroll content, status bar) in done t015 and the top-bar/left-edge insets in t045 — the translucent status bar is purely cosmetic and only safe once those insets exist.

## Out of scope

- The top-bar / left-edge safe-area insets themselves — owned by t045 (`landscape-safe-area-top-left-edges`); this task only *consumes* that protection.
- `touch-action` / `user-scalable` gesture locking — separate iPad-shell task (t047).
- 44pt coarse-pointer hit targets — separate iPad-shell task (t048).
- Light/dark adaptation of the status-bar text color — `black-translucent` always uses light glyphs; a theme-reactive status-bar style is not part of v0.1.0.
- Any Electron-window chrome changes — Electron is best-effort and unaffected by this iOS-only meta.

## Definition of Done

All must be true before status → done.

- [ ] Layer 1 tests written and green (if pure logic was touched) — n/a here
- [ ] Layer 2 smoke checklist completed with a live Remote Browser (if main.js/IPC touched) — n/a here
- [ ] Layer 3 screenshots captured and committed (if UI touched)
- [ ] `pnpm check` clean (Biome — lint + format)
- [ ] `pnpm typecheck` clean
- [ ] `pnpm test` green
- [ ] `pnpm dev` boots cleanly and the changed surface works end-to-end
- [ ] CLAUDE.md updated for any modified module (note the standalone status-bar-style alongside the existing iPad PWA description, if it adds clarity)
- [ ] ADR written if an architectural decision was made (expected: none)
- [ ] No commented-out code, no `console.log` debris, no AI attribution
- [ ] Task closed: status → done, file moved to `docs/tasks/done/`, t046 in commit

## Notes

- The dependency is referenced by id (`landscape-safe-area-top-left-edges`) because the ordering constraint is what matters: translucent status bar + missing top inset = clipped content. Verify t045's top inset is in place before merging this.
- `black-translucent` only has an effect in standalone display mode (Add to Home Screen). In a Safari tab it is inert, so there is no risk to the browser-tab fallback path.
- Reference: done t015 (iPad PWA manifest + safe-area insets) established `viewport-fit=cover` and per-component insets; t045 extends those to the top bar / left edge; this task is the cosmetic finish on top.

---

_When task status flips to `done`, move this file to `done/`._
