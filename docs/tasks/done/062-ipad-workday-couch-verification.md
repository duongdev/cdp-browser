# 062 — iPad couch finger-scroll/tap verification (NOT a new file — amend t018, run last)

- **Status:** done
- **Mode:** HITL
- **Ring:** inner
- **Slice:** 5-acceptance
- **Estimate:** M (folds into the t018 workday pass)
- **Depends on:** 061 (and every build slice 0–4)
- **Blocks:** none — this is the last gate; nothing waits on it

> **STOP — do not author `docs/tasks/062-*.md` as a real task.** This file is a
> **pointer**, not work. Decision 9 of the locked v0.1.0 scope (2026-05-30) is
> explicit: **t018 already exists, is the HARD tag-blocking gate, and runs LAST.**
> The couch finger-scroll/tap verification is **an amendment to t018**, not a new
> task. This entry exists only to make the dependency ordering visible in the
> spine (the couch pass runs after t061 and after all the build slices land). The
> real edit lives in `docs/tasks/018-ipad-workday-verification.md`. If you are an
> implementer who picked this up: close this pointer, do the work in t018.

## Goal

Make the existing iPad workday gate (t018) also cover the **couch, finger-only
secondary input model** — not just the Magic Keyboard / trackpad primary path it
already assumes. After the amendment, t018's acceptance set includes a finger-only
line: the daily driver (web PWA on iPad) must be usable lounging with no keyboard
attached — finger drag scrolls the remote page, a tap clicks, and a long-press
right-clicks, all through the lightweight touch-scroll-tap path (t051). t018 stays
the single hard v0.1.0 tag gate and runs last; this just widens what "would I want
to use this" means to include the couch case.

## Why now

v0.1.0 ships the **web PWA on iPad as the release surface**, and the locked input
model is two-tier: **Magic Keyboard primary, couch finger-only secondary.** The
secondary tier now has real plumbing behind it — t051 (touch-scroll-tap), t049
(touch-dismissable settings drawer), and t048 (≥44pt coarse-pointer targets) — so
the gate must actually exercise it, or we'd ship a "primary works, couch is stuck"
experience the inner ring exists to prevent. t018 is the final tag-blocking gate; it
already verifies the keyboard workday but says nothing about finger-only use.
Amending it (rather than spawning a parallel verification task) keeps **one** hard
gate and avoids a duplicate workday pass. It runs **last** because it can only pass
once every build slice it leans on is in place: t051 input, t048 targets, t049
drawer dismiss, and t061 transport-resilience.

## Acceptance criteria

The checkable outcome of this entry is that **t018 carries the couch line and stays
the last hard gate** — there is no separate 062 deliverable.

- [ ] `docs/tasks/018-ipad-workday-verification.md` gains a couch finger-only
      acceptance line: with **no keyboard attached**, finger drag scrolls the remote
      page (drag → `mouseWheel` deltas via t051), a tap clicks at the touched point,
      and a long-press fires a right-click — all landing accurately through the
      existing mouse pipeline + `toRemoteCoords()`
- [ ] The amended line states the couch session is run **lounging / handheld**, no
      Magic Keyboard, as a distinct pass from the keyboard workday (both must pass)
- [ ] The amended line references the supporting tasks by ID: t051 (touch-scroll-tap),
      t049 (settings drawer dismissable by touch — tap-outside + ≥44pt close button),
      t048 (≥44pt coarse-pointer hit targets)
- [ ] t018's header still reads as the v0.1.0 **hard tag-blocking gate** and the
      milestone order still has it running **last** (after t061 + all build slices)
- [ ] **No new `docs/tasks/062-*.md` work file is created** beyond this pointer; the
      README v0.1.0 table already marks this row "Not a new file — amends t018"
- [ ] t018's Layer 3 visual checklist gains a finger-only artifact: a short screen
      recording of finger scroll / tap / long-press on the installed iPad PWA

## Test plan

This is a **verification** entry; its "test" is the t018 workday pass itself. No
code module is authored here.

### Layer 1 — Pure logic (TDD)

n/a — verification task, no `src/lib/` or `notifications.js` logic is touched. (The
pure touch→coords math it relies on is owned and tested by t051, not here.)

### Layer 2 — Manual smoke (CDP/IPC)

n/a as a standalone smoke — this is the **full manual workday pass** under t018,
which is HITL and requires a live Remote Browser. The couch addendum, run on the
installed iPad PWA with no keyboard:

- [ ] Finger drag over the screencast canvas scrolls the remote page smoothly (no
      jump, no offset); release stops the scroll
- [ ] A single tap clicks the element under the finger (links, buttons, Teams/Outlook
      message rows) — lands first-try, no compression toward top-left
- [ ] A long-press opens the remote context menu (right-click) at the touched point
- [ ] The settings drawer can be opened and dismissed **by touch alone** (tap-outside
      + the ≥44pt close button from t049); mouse-leave never fires from a finger
- [ ] Every tapped control clears 44pt (t048) — no mis-taps during the couch session

### Layer 3 — Visual review

- [ ] Folded into t018's Layer 3: a **screen recording** of finger scroll, tap, and
      long-press on the installed iPad PWA (HITL — physical iPad; DevTools touch
      emulation is not a substitute and only sanity-checks the desktop-web path)
- [ ] The existing Magic Keyboard workday recording from t018 is unchanged

## Design notes

No code, no contracts, no modules. The only artifact this entry produces is **text in
another task file**.

- **Contracts changed:** none.
- **New modules:** none.
- **New ADR needed?** no — the touch-as-co-primary-input decision is recorded by t033
  (ADR-0009); this is verification, not a new decision.
- **The edit:** add the couch finger-only acceptance line (and its Layer 3 recording
  artifact) to `docs/tasks/018-ipad-workday-verification.md`. Do **not** weaken t018's
  "hard gate / runs last" framing; the couch line is an addition, not a replacement
  for the keyboard workday.

References: t018 (the gate being amended), t051 (touch-scroll-tap — supplies drag→
`mouseWheel`, tap→click, long-press→right-click reusing `toRemoteCoords()`), t049
(touch-dismissable settings drawer), t048 (≥44pt coarse-pointer targets), t061 (e2e
transport-resilience that must be green before the couch session runs), t033 /
ADR-0009 (touch as co-primary input), [../conventions/product.md](../conventions/product.md)
(daily-driver bar) and [../conventions/ux.md](../conventions/ux.md).

## Out of scope

- **Authoring a real 062 task.** This is a pointer; the work is the t018 amendment.
- **On-screen keyboard bridge** (finger typing without a hardware keyboard) — v0.2.
- **Full `Input.dispatchTouchEvent`** (pinch-zoom, momentum scrolling, multi-touch
  gestures) — v0.2; v0.1.0's couch tier is only the lightweight touch-scroll-tap.
- **Building** any of touch-scroll-tap, the settings-drawer dismiss, or the 44pt
  targets — those are t051 / t049 / t048; this entry only *verifies* them on-device.
- **Fixing** anything found during the couch session — per t018, blockers become their
  own follow-up tasks and do not block t018's closure.

## Definition of Done

All must be true before status → done. (For this pointer, "done" = the t018 amendment
landed and this pointer is closed in the same commit; t018 itself is closed by its own
workday pass.)

- [ ] Layer 1 tests written and green (if pure logic was touched) — n/a here
- [ ] Layer 2 smoke checklist completed with a live Remote Browser (if main.js/IPC touched) — covered by the t018 workday pass
- [ ] Layer 3 screenshots/recording captured and committed — the finger-only recording added to t018's artifacts
- [ ] `pnpm check` clean (Biome — lint + format)
- [ ] `pnpm typecheck` clean
- [ ] `pnpm test` green
- [ ] `pnpm dev` boots cleanly and the changed surface works end-to-end — n/a (no code; verified by the live iPad PWA pass)
- [ ] CLAUDE.md updated for any modified module — n/a (no module touched)
- [ ] ADR written if an architectural decision was made — n/a (covered by ADR-0009)
- [ ] No commented-out code, no `console.log` debris, no AI attribution
- [ ] Task closed: status → done, file moved to `docs/tasks/done/`, t062 in commit
      (and the actual couch verification recorded under t018)

## Notes

- The README v0.1.0 milestone table (Slice 5 — acceptance) already lists this row as
  "Not a new file — **amends t018** … runs last" — keep that the source of truth.
- The whole point of folding this into t018 is to keep **one** hard tag-blocking gate
  and **one** workday pass. Resist the urge to run a separate couch-only workday; do
  the keyboard workday and the couch session as two passes inside the same t018 gate.
- t018 can only pass once t051 (input), t048 (targets), t049 (drawer dismiss), and
  t061 (resilience) are all green — that is why this is the last thing to close.

---

_When task status flips to `done`, move this file to `done/`._
