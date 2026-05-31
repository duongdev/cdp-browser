# 048 — 44pt touch targets on coarse pointer (clear t016 debt)

- **Status:** done
- **Mode:** HITL
- **Ring:** inner
- **Slice:** 2-ipad-shell
- **Estimate:** 1d
- **Depends on:** 033
- **Blocks:** none

## Goal

On a coarse pointer (iPad finger), every interactive control in the chrome is at
least 44×44pt of effective tap area — the Apple HIG minimum — so taps land where
the user aims instead of missing by a few pixels. The increase is scoped behind
`@media (pointer: coarse)`: a Mac (fine pointer) keeps the exact dense layout it
has today, while the same build on iPad expands its touch targets. After this task,
the icon buttons in the sidebar, toolbar, notification bell, new-tab dialog, and
settings drawer no longer mis-fire on finger taps, and the t016 hit-target audit —
which was explicitly deferred pending iPad workday feedback — is closed.

## Why now

t016 (done) audited the chrome and found the icon buttons are 24/28/32/36px
(`icon-xs`/`icon-sm`/`icon`/`icon-lg`), none of which reach 44pt; it deferred the
size bump "to v2 pending iPad workday feedback" rather than ship it blind. That
feedback is now the v0.1.0 gate itself: the web PWA on iPad is the release surface,
and constant mis-taps are a "stuck" experience the inner ring exists to prevent.
t018 (the hard tag-blocking iPad workday gate) can't pass a couch session if the
controls are too small to hit. This is the task that pays down the debt t016 named.
It also absorbs the synthesis `settings-hit-targets-44pt` item (the settings drawer
was not in t016's audited set), so the whole chrome is covered in one pass.

## Acceptance criteria

- [ ] On `@media (pointer: coarse)`, every interactive icon button in
      `sidebar.tsx`, `toolbar.tsx`, `notification-bell.tsx`, `new-tab-dialog.tsx`,
      and `settings-dialog.tsx` has an effective tap area ≥44×44pt (CSS px), via a
      visible size bump or a padding/hit-slop expansion around a smaller visual glyph
- [ ] On `@media (pointer: fine)` (Mac), the layout is byte-for-byte unchanged —
      button sizes, spacing, and density match today's build (no regression)
- [ ] The expansion is driven purely by the `pointer` media feature, not by user
      agent, viewport width, or `navigator.standalone` — a trackpad-only Mac at iPad
      width stays dense; an iPad in Safari-tab mode still gets large targets
- [ ] Tappable sidebar rows (tab / pin entries), not just icon buttons, clear 44pt
      row height on coarse pointer
- [ ] No element overflows or clips its container at the larger coarse size
      (sidebar at the 180px iPad default, toolbar at iPad-width)
- [ ] Screenshots captured on both a fine-pointer (Mac) and a coarse-pointer
      (emulated/physical iPad) surface showing the two layouts side by side

## Test plan

Layers per [../conventions/tdd.md](../conventions/tdd.md). This is a layout-only
change — no pure logic, no main/IPC.

### Layer 1 — Pure logic (TDD)

n/a — this task only touches UI layout (CSS media query + Tailwind utility
classes). No `src/lib/` or `notifications.js` logic changes.

### Layer 2 — Manual smoke (CDP/IPC)

n/a — no main-process or IPC code is touched.

### Layer 3 — Visual review

- [ ] Mac fine-pointer (`pnpm dev`, Chrome DevTools, default mouse): chrome renders
      identically to the current build — capture before/after to confirm no drift
- [ ] Coarse-pointer emulation (Chrome DevTools device toolbar / touch emulation, or
      forced `pointer: coarse`): every listed control is visibly ≥44pt and easily
      tappable; nothing clips at the 180px iPad sidebar default
- [ ] Each surface exercised: sidebar tab/pin rows + row action buttons, toolbar nav
      + URL bar + settings + pin toggle, notification bell, new-tab dialog inputs and
      its pin quick-launch tiles, settings-drawer controls
- [ ] **HITL — physical iPad:** open the installed PWA and confirm finger taps on the
      sidebar, toolbar, bell, new-tab dialog, and settings drawer land first-try (this
      bit can't be fully trusted to DevTools emulation; verify on-device)
- [ ] Screenshots of both fine and coarse layouts captured and committed

## Design notes

Behavioral change only: the same components render with larger tap targets when the
primary pointer is coarse. No contracts, types, or module interfaces change.

- **Contracts changed:** none — layout only.
- **New modules:** none.
- **New ADR needed?** no. The touch-as-co-primary-input decision is recorded by t033
  (ADR-0009); this task is an application of that convention, not a new decision.

Implementation shape (describe the change, not line numbers):

- The shadcn `button` size variants (`icon-xs` 24px, `icon-sm` 28px, `icon` 32px,
  `icon-lg` 36px in `src/components/ui/button.tsx`) stay as-is for fine pointer.
  Under `@media (pointer: coarse)`, lift their effective hit area to ≥44pt — prefer a
  coarse-pointer rule in `src/index.css` that targets the `[data-slot=button]` icon
  sizes (and the equivalent slot for any non-button tappable, e.g. sidebar rows) so
  the bump lives in one place rather than being sprinkled per component. Where a
  larger visible box looks wrong, expand the hit area with padding / a transparent
  `::before` hit-slop overlay instead of growing the glyph.
- The five named components (`sidebar.tsx`, `toolbar.tsx`, `notification-bell.tsx`,
  `new-tab-dialog.tsx`, `settings-dialog.tsx`) are audited control-by-control; any
  bespoke tappable that isn't a shadcn `Button` (raw `<button>`, an icon-only
  affordance, a sidebar row) gets the same coarse-pointer minimum.
- Gate strictly on the `pointer` media feature. Do **not** key off viewport width
  (a wide iPad and a narrow Mac window both exist) or `navigator.standalone` (Safari-
  tab iPad still needs big targets). This keeps fine-pointer Mac untouched per AC.

References: t016 (done — the audit this completes, see its Notes "Hit target audit"),
t015 (done — safe-area baseline the iPad shell builds on), ADR-0009 / t033
(touch as co-primary input), [../conventions/ux.md](../conventions/ux.md) and
[../conventions/frontend.md](../conventions/frontend.md) for the shadcn-first,
four-state UI bar.

## Out of scope

- Touch gesture translation — finger drag → `mouseWheel`, tap → click, long-press →
  right-click. That is t051 (touch-scroll-tap), a separate Slice 3 task.
- The settings drawer's dismiss behavior — gating mouse-leave to fine pointer and
  adding tap-outside + a ≥44pt close button. That is t049; this task only sizes the
  drawer's interactive controls, it does not change how the drawer closes.
- An on-screen keyboard bridge and full `Input.dispatchTouchEvent` (pinch/momentum) —
  deferred to v0.2.
- Any change to the fine-pointer (Mac) layout, spacing, or density.
- Restructuring the shadcn `button` variants themselves (the fine-pointer sizes are
  unchanged; this only adds a coarse-pointer override).

## Definition of Done

All must be true before status → done.

- [ ] Layer 1 tests written and green (if pure logic was touched) — n/a here
- [ ] Layer 2 smoke checklist completed with a live Remote Browser (if main.js/IPC touched) — n/a here
- [ ] Layer 3 screenshots captured and committed (fine + coarse layouts)
- [ ] `pnpm check` clean (Biome — lint + format)
- [ ] `pnpm typecheck` clean
- [ ] `pnpm test` green
- [ ] `pnpm dev` boots cleanly and the changed surface works end-to-end
- [ ] CLAUDE.md updated for any modified module (note the coarse-pointer hit-target rule if a shared utility is added)
- [ ] ADR written if an architectural decision was made — n/a (covered by ADR-0009)
- [ ] No commented-out code, no `console.log` debris, no AI attribution
- [ ] Task closed: status → done, file moved to `docs/tasks/done/`, t048 in commit

## Notes

Free-form scratchpad for the implementer.

- t016's Notes already enumerate the offending sizes: `icon-xs` (24px), `icon-sm`
  (28px), `icon` (32px), `icon-lg` (36px) — all below 44pt. Start there.
- Prefer one coarse-pointer block in `src/index.css` over per-component edits so the
  rule is auditable in one place and future components inherit it for free.
- Watch the sidebar at its 180px iPad default (set in t016) — larger row/button
  targets must not force horizontal overflow or truncate titles unacceptably.
- DevTools touch emulation approximates `pointer: coarse` but isn't a substitute for a
  real finger; the on-device HITL check in Layer 3 is the one that actually closes
  the t016 debt, and it feeds directly into the t018 couch-session gate.

---

_When task status flips to `done`, move this file to `done/`._
