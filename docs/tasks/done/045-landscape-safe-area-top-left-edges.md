# 045 — landscape safe-area for the top + left edges

- **Status:** done
- **Mode:** HITL
- **Estimate:** 0.5d
- **Slice:** 2-ipad-shell
- **Ring:** inner
- **Depends on:** none
- **Blocks:** t046

## Goal

Task 015 shipped the PWA manifest, `viewport-fit=cover`, and safe-area padding for the **bottom** edge (the status bar's `pb-[env(safe-area-inset-bottom)]` and the sidebar scroll container's `pb-[max(0.5rem,env(safe-area-inset-bottom))]`). The 015 synthesis flagged that the **top** and **left** edges are still flush to the physical screen. On an iPad in landscape standalone, the side that carries the camera notch / rounded corner / Stage-Manager chrome eats into the top toolbar and the sidebar's left edge — the back/forward buttons, the URL bar's left end, the sidebar's first row, and the collapse control can sit under a system intrusion and become clipped or hard to tap. After this task, the top toolbar respects `env(safe-area-inset-top)`, the sidebar respects `env(safe-area-inset-left)` (and its header respects `inset-top`), and the toolbar's right-side actions respect `env(safe-area-inset-right)` — so no interactive control is ever under a rounded corner, notch, or system bar in landscape, installed-PWA, `viewport-fit=cover`. Each inset is applied as `max(existing-padding, env(...))` so a non-notched display (Mac desktop, desktop-web, Safari-tab) is byte-for-byte unchanged.

## Why now

This is the next inner-ring item on the **2-ipad-shell** slice and a direct obligation of [product.md](../conventions/product.md)'s never-clipped, always-tappable bar: the daily-driver surface is the web PWA on an iPad ([web-pwa-is-priority-surface](../memories/)), and on real hardware in landscape the home-indicator/notch side currently overlaps chrome 015 left flush. 015 deliberately scoped itself to the bottom edge (the home indicator was the visible offender in portrait-ish testing); the top + left landscape gap is the leftover. It blocks **t046** (status-bar-style meta `black-translucent`) because t046 changes how much of the top inset the system reserves — landing the `inset-top` padding here first means t046 only flips the meta tag and re-verifies, instead of discovering clipped controls at the same time. It can't wait: every landscape session today risks a control under the corner, which fails the v0.1.0 "I'd want to use this all day" gate.

## Acceptance criteria

- [ ] The **top toolbar** respects `env(safe-area-inset-top)` so its controls (back/forward/reload, URL bar, status dot, pin, bell, settings) clear the notch / status region in landscape standalone — the bar's content sits below the inset, not under it.
- [ ] The **sidebar left edge** respects `env(safe-area-inset-left)`: the first tab/pin row, the pinned tile grid, and the **collapse control** are never under the rounded corner — they shift right by the inset when one exists.
- [ ] The **sidebar header** (the `h-11` traffic-light / collapse strip at the top-left corner) respects both `inset-left` and `inset-top`, so the top-left corner — the worst case, where notch and rounded corner meet — is clear.
- [ ] The **collapsed rail** also respects `inset-left` (and its top `inset-top`), so collapsing the sidebar doesn't push the rail's icons under the corner.
- [ ] The **toolbar right-side actions** respect `env(safe-area-inset-right)` where they reach the right edge (the opposite-side rounded corner / notch when the iPad is rotated the other way).
- [ ] Every inset is applied as `max(existing-padding, env(safe-area-inset-*))` so a display with **zero** insets (Mac, desktop-web, Safari tab) renders **identically** to today — behavior-preserving, no new visible padding off-iPad.
- [ ] **No double-inset** with 015: the bottom edge (status bar, sidebar scroll `pb`) is untouched — this task adds only top / left / right, and does not re-pad anything 015 already padded.

## Test plan

Per [../conventions/tdd.md](../conventions/tdd.md): this task is pure CSS / layout — no pure logic, no main/IPC. It is Layer 3 only, and the only *true* confirmation is HITL on a real iPad (the `env()` values are non-zero only on physical hardware in landscape standalone).

### Layer 1 — Pure logic (TDD)

n/a — this task only touches UI layout (CSS utility classes), no pure logic.

### Layer 2 — Manual smoke (CDP/IPC)

n/a — no main-process or IPC code is touched.

### Layer 3 — Visual review

- [ ] Desktop-web Chrome (DevTools) confirms the new `max(..., env(...))` classes **apply** and that with zero insets the layout is pixel-identical to before (the `max()` falls through to the existing padding). DevTools can emulate a device that reports safe-area insets to confirm the env branch wins when an inset exists.
- [ ] Off-iPad regression: `pnpm dev` (Electron) and desktop-web both render the toolbar and sidebar exactly as today — no new gap, no shifted controls (insets resolve to 0).
- [ ] **TRUE confirmation is HITL on a real iPad** in **landscape, installed standalone PWA**, `viewport-fit=cover`: screenshots of (a) the top toolbar clear of the notch/status region, (b) the sidebar's first row + collapse control clear of the rounded corner on the home-indicator/notch side, (c) the top-left corner where both meet, and (d) the right-side toolbar actions when the iPad is rotated so the notch is on the right. No control under any intrusion.
- [ ] On-device confirmation across the full workday is covered by the **t018 gate** — flag explicitly that desktop-web cannot stand in for the real-hardware sign-off here.

## Design notes

This is a CSS-only change applied per-component (the same per-component discipline 015 chose, to avoid the global-`body`-padding black bar 015 documented). No module contracts change, no new modules, no ADR.

- **Top toolbar** (the `h-11 px-3` bar) — add top padding `pt-[max(0px,env(safe-area-inset-top))]` (or fold the inset into the bar's effective height so the `h-11` content still centers below the inset) and right padding `pr-[max(<existing>,env(safe-area-inset-right))]` on the right-actions cluster. The bar's existing `px-3` left padding stays as-is — the **sidebar** owns the left edge in the flex row, so the toolbar doesn't also need `inset-left` (it never touches the left screen edge; the sidebar is to its left). Confirm this in review: if the sidebar is collapsed to a rail, the rail still owns the left edge, so the toolbar still never reaches `inset-left`.
- **Sidebar root / header** — the sidebar is the left-most column, so it owns `inset-left` for the whole left edge and `inset-top` for its header strip. Apply `inset-left` as left padding on the sidebar's content (header strip + scroll body + collapsed rail) via `pl-[max(<existing>,env(safe-area-inset-left))]`, and `inset-top` on the header strip so the collapse control clears the corner. Keep the existing bottom padding from 015 exactly as-is.
- **Collapsed rail** — mirror `inset-left` + header `inset-top` so the rail's expand control and icon column never slide under the corner.
- **`max()` guard everywhere** — every inset utility wraps the existing padding in `max(existing, env(...))`. With no insets the env term is `0` (or `env(...) ` resolves to `0px`), so `max()` returns the existing padding and nothing changes off-iPad. This is the single rule that keeps the change behavior-preserving on Mac/desktop.
- **No `inset-bottom` here** — 015 owns the bottom (status bar + sidebar scroll). This task must not touch those; re-padding them would double-inset.

- **Contracts changed:** none — CSS utility classes on existing components only. No `CdpBridge`, no IPC, no props.
- **New modules:** none.
- **New ADR needed?** No. This is a layout refinement under the existing iPad-shell direction (the manifest / safe-area approach 015 set); it records nothing new architecturally.

## Out of scope

- **Bottom insets** — 015 (done) owns `inset-bottom` on the status bar and sidebar scroll. This task adds top / left / right only and leaves the bottom untouched.
- **`apple-mobile-web-app-status-bar-style` = `black-translucent`** (and the extra top inset it reserves) — that is **t046**, which this task blocks. t046 changes the status-bar meta; this task lands the `inset-top` padding it relies on.
- **Touch hit-target sizing** (44pt minimum on coarse pointers) — that is **t048**. This task only moves controls out from under intrusions; it does not resize them.
- **Adaptive orientation** (portrait support) — the manifest stays landscape-locked (015 decision); this task targets landscape only.
- Any change to the **screencast canvas** letterbox math — the canvas reaching the right edge is handled by Viewport Transform; this task does not touch coordinate mapping.

## Definition of Done

All must be true before status → done.

- [ ] Layer 1 tests written and green (if pure logic was touched) — n/a, CSS only
- [ ] Layer 2 smoke checklist completed with a live Remote Browser (if main.js/IPC touched) — n/a
- [ ] Layer 3 screenshots captured and committed (desktop-web zero-inset regression + the real-iPad landscape edges; on-device sign-off via t018)
- [ ] `pnpm check` clean (Biome — lint + format)
- [ ] `pnpm typecheck` clean
- [ ] `pnpm test` green
- [ ] `pnpm dev` boots cleanly and the toolbar + sidebar render identically to today off-iPad (insets resolve to 0)
- [ ] CLAUDE.md updated for any modified module (the safe-area note in the web-build / PWA section should list the top + left + right insets alongside the bottom ones 015 recorded)
- [ ] ADR written if an architectural decision was made (expected: none)
- [ ] No commented-out code, no `console.log` debris, no AI attribution
- [ ] Task closed: status → done, file moved to `docs/tasks/done/`, t045 in commit

## Notes

- Audit 015 first (`docs/tasks/done/015-*`): it applied `pb-[env(safe-area-inset-bottom)]` to the status bar and `pb-[max(0.5rem,env(safe-area-inset-bottom))]` to the sidebar scroll container. Do **not** re-touch those — this task is strictly the top / left / right edges.
- The flex row is `Sidebar | (Toolbar over Viewport)`. The **sidebar** is the left-most column, so it — not the toolbar — owns `inset-left`. The **toolbar** owns `inset-top` for the main column and `inset-right` for its right actions. The sidebar **header** owns the top-left corner (`inset-left` + `inset-top` together) — that corner is the worst case and the one most likely to clip a control.
- `env(safe-area-inset-*)` is `0` on every non-notched display, so the `max(existing, env())` form is the whole behavior-preserving guarantee. Verify the zero-inset case off-iPad before claiming done — a stray non-`max` `env` would add visible padding on a Mac.
- True confirmation is **real iPad in landscape standalone** — DevTools can prove the CSS applies but cannot reproduce the actual notch/corner geometry. The full on-device sign-off rides the **t018** workday gate; capture the edge screenshots here as the layer-3 artifact.

---

_When task status flips to `done`, move this file to `done/`._
