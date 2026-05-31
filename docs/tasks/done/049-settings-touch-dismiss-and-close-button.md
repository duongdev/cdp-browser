# 049 — settings drawer: pointer-aware dismiss + explicit close button

- **Status:** done
- **Mode:** HITL
- **Ring:** inner
- **Slice:** 2-ipad-shell
- **Estimate:** 1d
- **Depends on:** touch-first-co-primary-input-convention (t033 / ADR-0009)
- **Blocks:** none

## Goal

Today the settings drawer closes by **mouse-leave**: a 500ms leave-timer fires
when the cursor sits outside the (non-modal) panel, unless the drawer was opened
or promoted to *committed* mode (Cmd+, or any keypress inside). On a Mac trackpad
this is loved — flick away, it dismisses. On an iPad finger it is a trap: a touch
synthesizes a `mouseleave` the instant the finger lifts, so the drawer dismisses
itself out from under the user before they can read it, and there is **no other
way to close it** (no scrim — the sheet renders with `showOverlay={false}`, no
visible close button). After this task the drawer is dismissable on a finger the
way a touch UI expects — a **tap on the scrim** and an **explicit ≥44pt close (X)
button** in the drawer header — while the beloved mouse-leave auto-close is
**kept intact for a fine pointer** and simply **never fires for a coarse pointer**
(a touch-synthesized `mouseleave` can no longer dismiss it). Cmd+, and Esc keep
toggling/closing the drawer in both modes. Pointer type is read **live** off the
`(pointer: fine)` media query (and the triggering event's `pointerType` where one
is available), so a user who detaches the Magic Keyboard and switches to finger
mid-session gets the coarse branch without a reload.

## Why now

This is an inner-ring **2-ipad-shell** correctness bug, not polish: on the release
surface (the iPad PWA) the settings drawer is effectively **unusable** — it
self-dismisses on the first touch and offers no manual close, so the user cannot
change the CDP address, theme, connection mode, or push toggle without a fight.
That fails [product.md](../conventions/product.md)'s never-stuck bar and blocks the
t018 iPad-workday gate (you cannot complete a couch session if you can't open
settings). It depends on t033 because the fix is a direct application of the
**touch-as-co-primary-input** convention (ADR-0009): the dismiss state machine must
branch on pointer *capability*, live, rather than assume a mouse. It is deliberately
**separate from t048** (44pt hit-target sweep) — t048 sizes the drawer's *controls*;
this task changes how the drawer *closes* and adds the one new control (the close
button) that close behavior needs. t048's out-of-scope already hands this off here.

## Acceptance criteria

- [ ] On a **fine pointer** (`matchMedia("(pointer: fine)").matches`), the existing
      mouse-leave auto-close is **unchanged**: the 500ms leave-timer still arms on
      `mouseleave` of a non-committed (mouse-opened) drawer, is cleared on
      `mouseenter` / keypress / commit, and is suppressed while a `Select` popover is
      open — byte-for-byte the behavior shipped today.
- [ ] On a **coarse pointer**, mouse-leave **never** closes the drawer: a
      `mouseleave` synthesized by a finger lift does not arm the leave-timer and does
      not dismiss the drawer. No leave-timer is scheduled on the coarse path at all.
- [ ] An explicit **close (X) button in the drawer header** dismisses the drawer on
      **any** pointer (fine or coarse), with an effective tap area **≥44×44pt** on
      coarse pointer (it may stay denser on fine, consistent with t048's split).
- [ ] **Tap/click outside** the drawer (a scrim/overlay) dismisses it on coarse
      pointer. On fine pointer the outside-interaction behavior is whatever it is
      today (the non-modal `onInteractOutside` that ignores `Select` popovers).
- [ ] **Cmd+,** toggles the drawer and **Esc** closes it in **both** pointer modes,
      exactly as today (committed-on-keyboard-open semantics preserved).
- [ ] Pointer type is detected **live**, not via a one-time UA sniff: the branch
      reads the `(pointer: fine)` / `(pointer: coarse)` media query (and/or the
      event's `pointerType`) at the moment of the leave/dismiss, so detaching a
      keyboard and switching to finger flips to the coarse branch with no reload.
- [ ] The existing **committed / mouse-mode** state machine (`committed`,
      `onRequestOpenMouse`, `onCommit`, `LEAVE_CLOSE_MS`, the `leaveTimer` ref) stays
      for the fine-pointer path; the coarse path is an added branch, not a rewrite —
      no regression to the fine-pointer choreography.

## Test plan

Per [../conventions/tdd.md](../conventions/tdd.md): the dismiss decision is the only
candidate for pure logic; the rest is renderer-only (no IPC), verified visually.

### Layer 1 — Pure logic (TDD)

- [ ] **If** the leave-vs-keep decision is extracted to a pure predicate (e.g.
      `shouldAutoCloseOnLeave({ pointerFine, committed, selectOpen })` or a tiny
      reducer), TDD it: fine + non-committed + no select-open → arm/close; coarse →
      never close; committed → never close; select-open → never close. Co-locate with
      `src/lib/` and the existing test layout.
- [ ] **Else** n/a, with justification: the branch is a one-line
      `matchMedia("(pointer: fine)").matches` guard threaded into the existing
      `onMouseLeave` handler — too thin to warrant a module, and the surrounding
      timer/commit logic is effectful React state. Record that choice in Notes.

### Layer 2 — Manual smoke (CDP/IPC)

n/a — renderer-only. No main-process, IPC, or settings-persistence change (the
dismiss branch touches no `settings.json` / ui-state field). If the work ends up
touching persistence, add a smoke step here.

### Layer 3 — Visual review

Against `pnpm web` (desktop web is acceptable for the pointer-mode transitions;
physical iPad is the HITL gate):

- [ ] **Fine pointer** (Chrome DevTools, real mouse): open the drawer from the gear,
      move the cursor off the panel → it still auto-closes after the leave delay;
      Cmd+, opens committed (no auto-close); Esc closes; the close (X) button closes.
- [ ] **Coarse pointer** (Chrome DevTools touch/`pointer: coarse` emulation): open the
      drawer, lift the finger / move the synthetic pointer off-panel → it does **not**
      close; tap the scrim → it closes; tap the close (X) button → it closes.
- [ ] The close (X) button is visible and ≥44pt on the coarse emulation and reads as
      part of the drawer header (four-state UI bar — at minimum the populated state).
- [ ] **HITL — physical iPad PWA:** open settings on a finger, confirm it does **not**
      self-dismiss on the first touch, and that both the scrim tap and the close button
      dismiss it first-try. This is the bit DevTools emulation can't fully be trusted
      for; it feeds the t018 couch-session gate.
- [ ] Screenshots of the fine and coarse dismiss paths captured and committed.

## Design notes

Behavioral change to the drawer's close choreography only. The fine-pointer state
machine is preserved verbatim; a coarse-pointer branch is added beside it. The
**LOCKED DECISION** is: keep mouse-leave for fine, gate it strictly behind
`(pointer: fine)`, and give coarse two deliberate dismiss affordances (scrim tap +
explicit ≥44pt close button). Cmd+, and Esc work in both modes.

- **`src/components/settings-dialog.tsx`** — the `onMouseLeave` handler currently
  arms the leave-timer whenever the drawer is non-`committed` and no `Select` is
  open. Add a **live fine-pointer guard** at the top of that handler:
  `if (!matchMedia("(pointer: fine)").matches) return` — so a coarse pointer never
  arms the timer and a touch-synthesized `mouseleave` is inert. The guard is read at
  call time (live), not cached at mount, satisfying the keyboard-detach case. The
  `committed` / `selectOpen` / `LEAVE_CLOSE_MS` / `leaveTimer` machinery is otherwise
  untouched on the fine path.
- **Close (X) button** in the `SheetHeader`: an icon button (HugeIcons `Cancel01`/
  `MultiplicationSign` style, shadcn `Button` `variant="ghost"`) that calls
  `onOpenChange(false)`. It must clear `leaveTimer` defensively before closing. On
  coarse pointer its effective tap area is ≥44pt (per ADR-0009 / the same coarse
  rule t048 introduces — reuse that rule, don't fork a second one). Note: shadcn's
  default `SheetContent` ships a built-in close button, but this drawer renders with
  `showOverlay={false}` and a custom header; verify whether the default close is
  present/usable here and, if not, add the explicit one rather than relying on it.
- **Scrim / tap-outside on coarse:** the sheet is intentionally non-modal with
  `showOverlay={false}` so the live page stays interactive behind it on a Mac. On a
  coarse pointer there is no hover, so an outside *tap* is the natural dismiss. Make
  outside-tap dismiss on coarse — either by rendering a lightweight scrim only under
  `(pointer: coarse)` whose tap calls `onOpenChange(false)`, or by letting the
  drawer's non-modal `onInteractOutside` close on coarse (it currently only *prevents*
  closing for `Select` popovers; on coarse a genuine outside tap should fall through
  to close). Keep the fine-pointer outside behavior exactly as today.
- **Esc + Cmd+,:** Esc dismissal is the Sheet's native behavior and the `onKeyDownCapture
  → onCommit` path; Cmd+, is wired in `app.tsx` (`toggle` that opens committed). Both
  are pointer-agnostic and must keep working — do not gate them behind the pointer
  branch. Confirm the close-button and scrim paths route through the same
  `onOpenChange(false)` that `app.tsx`'s `handleSettingsOpenChange` already consumes
  (it resets `settingsCommitted` on close), so no new open/close contract is needed.

- **Contracts changed:** none. `SettingsDialogProps` is unchanged — `onOpenChange`,
  `committed`, `onRequestOpenMouse`, `onCommit` already carry everything the new
  branch needs. `app.tsx`'s settings choreography (`handleSettingsOpenChange`,
  `handleSettingsRequestOpenMouse`, `handleSettingsCommit`, the Cmd+, toggle) is
  unchanged.
- **New modules:** none expected. Optionally a `src/lib/` predicate for the
  leave-vs-keep decision **iff** it earns Layer-1 coverage (see Test plan Layer 1);
  otherwise the branch stays inline in the component.
- **New ADR needed?** No. This is an application of **ADR-0009** (touch as
  co-primary input, from t033) — branch on pointer capability, live. If the
  scrim-on-coarse approach turns out to deserve a recorded decision, append to
  ADR-0009 rather than opening a new one.

```ts
// the only new decision — read live, per dismiss event, not cached at mount
function shouldArmLeaveTimer(opts: {
  pointerFine: boolean // matchMedia("(pointer: fine)").matches, read now
  committed: boolean    // keyboard-opened / promoted drawer never auto-closes
  selectOpen: boolean   // a portaled Select is open; cursor legitimately off-panel
}): boolean {
  return opts.pointerFine && !opts.committed && !opts.selectOpen
}
// coarse pointer ⇒ false ⇒ no timer ⇒ a touch-synthesized mouseleave is inert.
// coarse dismiss instead via: header close (X) button, or a scrim tap.
```

## Out of scope

- The **44pt hit-target sweep** across the rest of the chrome (sidebar, toolbar,
  bell, new-tab dialog, and the drawer's *other* controls) — that is **t048**. This
  task only adds the **close (X)** control the dismiss behavior needs and ensures
  *it* clears 44pt; it does not resize the drawer's existing controls. (Reuse t048's
  coarse-pointer rule for the close button rather than forking a second rule.)
- The **settings information-architecture / grouping redesign** (re-laying-out the
  cards, tabs, sectioning) — deferred to **v0.2**.
- The **version / build-SHA About row** in settings — that is **t050**; this task
  does not add or touch a version display.
- Touch gesture translation in the *viewport* (finger drag → wheel, tap → click,
  long-press → right-click) — that is **t051**; this task is chrome-only.
- Any change to the **fine-pointer (Mac)** dismiss behavior — it must stay
  byte-for-byte identical to today.

## Definition of Done

All must be true before status → done.

- [ ] Layer 1 tests written and green **if** the leave-vs-keep predicate was
      extracted; otherwise the n/a justification is recorded in Notes
- [ ] Layer 2 n/a confirmed (no main.js/IPC/persistence touched)
- [ ] Layer 3 screenshots captured and committed (fine: still auto-closes; coarse:
      mouse-leave inert, scrim tap + close button dismiss)
- [ ] `pnpm check` clean (Biome — lint + format)
- [ ] `pnpm typecheck` clean
- [ ] `pnpm test` green
- [ ] `pnpm web` boots cleanly and the drawer dismisses correctly on both pointer
      modes end-to-end
- [ ] **HITL — physical iPad PWA:** settings drawer no longer self-dismisses on
      first touch; scrim tap and close button both dismiss first-try (feeds t018 gate)
- [ ] CLAUDE.md updated if a shared coarse-pointer rule or `src/lib/` predicate is
      added (the "Settings persistence" / settings-dialog notes reflect the new
      pointer-aware dismiss + close button)
- [ ] ADR written if an architectural decision was made — expected: none (covered by
      ADR-0009); append to it only if the scrim-on-coarse approach warrants a note
- [ ] No commented-out code, no `console.log` debris, no AI attribution
- [ ] Task closed: status → done, file moved to `docs/tasks/done/`, t049 in commit

## Notes

Free-form scratchpad for the implementer.

- **LOCKED DECISION (do not drop mouse-leave):** the user *loves* the mouse-leave
  auto-close on the trackpad. Keep it. The whole task is gating it behind
  `(pointer: fine)` and adding the coarse-pointer dismiss affordances beside it.
  Do not "simplify" by removing mouse-leave or by replacing it with a close button
  everywhere — that would regress the fine-pointer experience.
- The dismiss guard must be **live**, read per event — `matchMedia("(pointer: fine)").matches`
  (or the event's `pointerType` when present), **not** a value sampled once at mount
  or a UA string. The Magic-Keyboard-detach case is an explicit AC.
- A finger lift fires a synthetic `mouseleave`; that is the exact event the fine-only
  guard must neutralize. Verify on a *real* iPad — DevTools touch emulation does not
  perfectly reproduce iPad's mouse-event synthesis.
- The drawer is **non-modal with `showOverlay={false}`** on purpose (the live page
  stays interactive behind it on Mac). Don't make it modal on fine pointer to get a
  scrim — only introduce scrim/outside-tap-close behavior on the coarse branch, or
  you'll regress the Mac flow.
- shadcn `SheetContent` has a default close button; this drawer's custom header +
  `showOverlay={false}` may suppress or misplace it. Check before adding a second one.
- Reuse t048's `@media (pointer: coarse)` 44pt rule for the close button; if t048
  hasn't landed yet, add the coarse rule for this one control and let t048 generalize
  it (flag the overlap so they don't fork two rules).

---

_When task status flips to `done`, move this file to `done/`._
