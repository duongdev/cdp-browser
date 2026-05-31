# 033 — touch-first co-primary input convention + ADR-0009

- **Status:** done
- **Ring:** inner
- **Slice:** 0-scaffolding
- **Mode:** AFK
- **Estimate:** 0.5d
- **Depends on:** none
- **Blocks:** 047 (`canvas-touch-action-lock`), 048 (`touch-hit-targets-44pt-coarse-pointer`), 049 (`settings-touch-dismiss-and-close-button`), 051 (`touch-scroll-tap-forwarding`)

## Goal

Make touch a **co-primary input surface** alongside the keyboard in the written conventions, so the v0.1.0 touch tasks are unblocked. Today `docs/conventions/ux.md` and `docs/conventions/product.md` both hard-code a "desktop Electron app, no touch" stance — but the daily-driver surface is the web PWA on an iPad. This task amends both convention files to authorize touch (Magic Keyboard primary, couch finger-only secondary) and records the decision in a new **ADR-0009 (Status: Accepted)**. Keyboard-first parity is preserved — the keyboard stays the power path; touch is added as a co-primary surface, not a replacement. This is a **doc-only** task: no code, no UI.

## Why now

This is the convention-before-code gate for the entire v0.1.0 touch program. The project rule is "convention before code" — code that contradicts a written convention cannot land until the convention is amended first. Every inner-ring touch task is blocked behind it: `canvas-touch-action-lock` (047), `touch-hit-targets-44pt-coarse-pointer` (048), `settings-touch-dismiss-and-close-button` (049), and `touch-scroll-tap-forwarding` (051) all add touch behavior that the current `ux.md` / `product.md` explicitly forbid. A reviewer (or a future agent) reading those files would correctly reject the code. Amending the docs and recording the decision in an ADR removes that block and gives the touch tasks a single authority to cite. It's slice-0 scaffolding: cheap, low-risk, and it must land before any touch code.

## Acceptance criteria

Testable bullets. Each one should be checkable as true/false at completion.

- [ ] `docs/conventions/ux.md` no longer states "Mouse is the fallback, not the default" as the whole model; the opening interaction-model paragraph names **keyboard-first with touch as a co-primary surface** (Magic Keyboard primary, couch finger-only secondary) on the web PWA, while keeping keyboard parity as the power path.
- [ ] `docs/conventions/ux.md` line "No mobile / touch targets needed — CDP Browser is a desktop Electron app." is **replaced** with a positive touch-target statement: coarse-pointer targets meet **44pt**, and touch dismissal/affordances are required where a fine-pointer-only interaction (e.g. mouse-leave close) would otherwise strand a touch user.
- [ ] `docs/conventions/product.md` "A mobile app (no mobile targets, no touch-first UX)." is rewritten so the "is not a mobile app / multi-window app" framing survives but the **"no touch-first UX" exclusion is removed**, replaced by a note that the web PWA is touch-capable (co-primary), without claiming to be a phone app.
- [ ] Neither file deletes or weakens the existing **keyboard-first** parity guidance, the `aria-label` rule, or the `prefers-reduced-motion` rule.
- [ ] `docs/adr/0009-touch-first-co-primary-input.md` exists, follows `docs/adr/TEMPLATE.md`, **Status: Accepted**, dated 2026-05-30, and records: touch is co-primary; 44pt coarse-pointer targets; screencast touch input = finger-drag → `mouseWheel`, tap → click, long-press → right-click (reusing the existing mouse pipeline + `toRemoteCoords`); mouse-leave auto-close gated to `(pointer: fine)` so it never fires from a synthesized touch event.
- [ ] ADR-0009 Consequences section names the deferred-to-v0.2 boundary explicitly: on-screen-keyboard bridge and full `Input.dispatchTouchEvent` (pinch/momentum) are **out** of this decision.
- [ ] The ADR is internally consistent with the locked v0.1.0 wording (it does not promise pinch-zoom, momentum scrolling, or an on-screen keyboard for v0.1.0).
- [ ] `CONTEXT.md` is updated only if a new domain term is introduced; if no new term, it is left untouched (note this in the PR).

## Test plan

Per [../conventions/tdd.md](../conventions/tdd.md). This is a documentation-only change — no pure logic, no CDP/IPC glue, no renderer UI — so all three testing layers are n/a. Verification is editorial.

### Layer 1 — Pure logic (TDD)

- [ ] n/a — docs only; no pure module is added or changed.

### Layer 2 — Manual smoke (CDP/IPC)

- [ ] n/a — no main-process or IPC code is touched. No live Remote Browser required.

### Layer 3 — Visual review

- [ ] n/a — no renderer UI or layout is touched.

**Editorial verification (in lieu of the three layers):**

- [ ] Re-read `ux.md` and `product.md` end-to-end after the edits; confirm no surviving sentence still asserts "no touch" / "desktop-only" / "mouse is the fallback" as the whole model.
- [ ] Confirm `ADR-0009` cross-references the convention files it authorizes and the downstream touch tasks (033's `Blocks` set) read coherently against it.
- [ ] `pnpm check` clean on the touched markdown (Biome formatting on docs, if in scope); `pnpm typecheck` and `pnpm test` are unaffected and stay green.

## Design notes

Doc-only. No contracts, types, or modules change. The edits are surgical replacements of the anti-touch lines, not rewrites of the files.

- **`docs/conventions/ux.md`** — amend the opening interaction-model paragraph (currently "The UX optimization is **keyboard-first**… Mouse is the fallback, not the default.") to add touch as a co-primary surface on the web PWA while keeping keyboard-first parity. Replace the standalone line "No mobile / touch targets needed — CDP Browser is a desktop Electron app." with the positive 44pt-coarse-pointer + touch-dismissal rule. Leave the `aria-label`, reduced-motion, and "reduce clicks" guidance intact.
- **`docs/conventions/product.md`** — rewrite the "is not" bullet "A mobile app (no mobile targets, no touch-first UX)." so the not-a-phone / not-a-multi-window framing survives but the "no touch-first UX" exclusion is dropped, with a one-clause note that the web PWA is touch-capable. The "Scope creep toward any of these is a design decision, not a task. Open an ADR." line stays — and this ADR is exactly that open ADR.
- **`docs/adr/0009-touch-first-co-primary-input.md`** — new ADR from `docs/adr/TEMPLATE.md`. **Status: Accepted** (not Proposed) because it gates v0.1.0 code that lands this milestone. Context: daily driver is the web PWA on iPad, but the docs forbid touch. Decision: touch is co-primary; 44pt coarse-pointer targets; the screencast touch model (drag → `mouseWheel`, tap → click, long-press → right-click, reusing the mouse pipeline + `toRemoteCoords`); mouse-leave auto-close gated to `(pointer: fine)`. Consequences name the v0.2 deferral boundary (on-screen-keyboard bridge, full `Input.dispatchTouchEvent`). Alternatives: keep desktop-only (rejected — contradicts the actual daily-driver surface); a full touch rewrite with native touch events (rejected for v0.1.0 — `Input.dispatchTouchEvent` pinch/momentum deferred to v0.2 per the locked scope).

- **Contracts changed:** none — documentation only.
- **New modules:** none.
- **New ADR needed?** yes — `ADR-0009: touch-first co-primary input` (Status: Accepted). This is the architectural decision this task records; it is the gate for the v0.1.0 touch tasks.

## Out of scope

What this task explicitly does NOT do. The adjacent v0.2 deferrals are named so a reader doesn't assume this ADR authorizes them.

- **No code.** No renderer, main-process, or server change. The touch *behaviors* are implemented by the downstream tasks (047/048/049/051) — this task only authorizes them in the conventions + ADR.
- **No on-screen-keyboard bridge** — deferred to v0.2; the ADR explicitly marks it out of this decision.
- **No full `Input.dispatchTouchEvent`** (pinch-zoom, momentum/inertial scrolling, multi-touch gestures) — deferred to v0.2; v0.1.0 touch reuses the existing single-pointer mouse pipeline only.
- **No Electron touch support** — the release surface is the web PWA; Electron stays mouse/keyboard, best-effort.
- **No changes to `frontend.md`, `tdd.md`, or other conventions** beyond the two named files — if a third file also asserts "desktop-only / no touch", note it for a follow-up rather than expanding this task.

## Definition of Done

All must be true before status → done.

- [ ] Layer 1 tests written and green (if pure logic was touched) — n/a, docs only
- [ ] Layer 2 smoke checklist completed with a live Remote Browser (if main.js/IPC touched) — n/a
- [ ] Layer 3 screenshots captured and committed (if UI touched) — n/a
- [ ] `pnpm check` clean (Biome — lint + format)
- [ ] `pnpm typecheck` clean
- [ ] `pnpm test` green
- [ ] `pnpm dev` boots cleanly and the changed surface works end-to-end — n/a (no surface changed); confirm `pnpm dev` still boots after the doc edits
- [ ] CLAUDE.md updated for any modified module — n/a (no module modified)
- [ ] ADR written if an architectural decision was made — yes, ADR-0009
- [ ] No commented-out code, no `console.log` debris, no AI attribution
- [ ] Task closed: status → done, file moved to `docs/tasks/done/`, t033 in commit

## Notes

- This is the first ADR with **Status: Accepted on creation** rather than Proposed — justified because it gates v0.1.0 code shipping in the same milestone; record that reasoning in the ADR if a reviewer questions the status.
- Keep the keyboard-first language — the goal is *co-primary*, not *touch-first replacing keyboard*. The Magic Keyboard is the primary input; couch finger-only is the secondary surface that must not be stranded.
- Cross-reference: the locked v0.1.0 scope (`docs/tasks/README.md` → "v0.1.0 milestone") and the touch tasks 047/048/049/051 cite this ADR as their authority.
- If the markdown edits surface a third convention file with anti-touch wording, capture it as a separate idea/task — do not expand scope here.

---

_When task status flips to `done`, move this file to `done/`._
