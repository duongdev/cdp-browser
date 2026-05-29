# 024 — add pure tab lifecycle planner for close and switch

- **Status:** done
- **Mode:** HITL
- **Estimate:** 1d
- **Depends on:** none
- **Blocks:** none

## Goal

Extract the cross-kind close and switch decision out of `app.tsx` into a new pure `tab-lifecycle.ts` module that composes the existing Active Order, Closed Tabs, and Pins modules. `planClose(input)` answers the whole "what happens when this Tab or Local Tab closes" question in one call — returning the `ClosedEntry` to push, the next `ActiveRef` to activate (across both kinds, MRU then first-visible fallback), and whether the active surface should be cleared entirely — while `planSwitch(order, ref)` returns the new MRU order for an activation. After this ships, `app.tsx` stops re-deriving the same MRU close-dance separately in its CDP close path and its Local Tab close path; both paths build the same input and apply the single returned directive, so the close-fallback protocol lives in one tested place instead of being duplicated by hand.

## Why now

`app.tsx` is the de-facto coordinator that already owns the close and switch effects, but the decision logic — drop from Active Order, find the most-recent still-open Tab of either kind, fall back to the first visible Tab, push the closed URL onto the reopen stack, revert a Pin whose held Tab closed — is written twice (once per kind) and is impossible to unit-test without React. A pure planner gives the protocol locality and a clean test seam (close the Active Tab → MRU fallback within a kind → MRU fallback across kinds → first-visible fallback → nothing left) with zero React in the loop. It composes modules that already exist (Active Order, Closed Tabs, Pins) rather than reinventing them, and it is independent of the web-transport track, so it can land without coordinating with any other deepening task.

## Acceptance criteria

- [ ] `planClose(input)` returns `{ closedEntry, nextActive, clearActive }` for both `kind: 'cdp'` and `kind: 'local'` closures.
- [ ] When the closed Tab was the Active Tab, `nextActive` is the most-recently-used still-open `ActiveRef` of *either* kind (via Active Order), and only when none is open does it fall back to the first visible Tab in stable order.
- [ ] When the closed Tab was *not* active, `nextActive` is `null` and `clearActive` is `false` (the active surface is untouched).
- [ ] When nothing remains open after the close, `nextActive` is `null` and `clearActive` is `true`.
- [ ] `closedEntry` is a `ClosedEntry` (`{ kind, url }`) carrying the closed Tab's URL, ready to push onto the Closed Tabs stack.
- [ ] When the closed Tab was held by a Pin, the planner reports that the Pin must revert to unlinked (the directive surfaces it; `app.tsx` performs the persistence/effect).
- [ ] `planSwitch(order, ref)` returns a new Active Order with `ref` moved to most-recent, leaving the input array unmutated.
- [ ] `app.tsx`'s CDP close path and Local Tab close path both delegate to `planClose` and apply the returned directive — no per-kind MRU fallback logic remains inline.
- [ ] `tab-lifecycle.ts` is pure: no React, no IPC, no DOM, no `window` access; returns new values and never mutates inputs.

## Test plan

Which testing layers apply (see [../conventions/tdd.md](../conventions/tdd.md)) and what specifically is tested.

### Layer 1 — Pure logic (TDD)

Table-driven `tab-lifecycle.test.ts`, written test-first:

- [ ] `planClose` — close the Active CDP Tab with a more-recent sibling still open → `nextActive` is that MRU CDP sibling.
- [ ] `planClose` — close the Active CDP Tab when the only other open surface is a Local Tab → `nextActive` crosses kinds to the Local Tab.
- [ ] `planClose` — close the Active Tab when Active Order is exhausted but visible Tabs remain → `nextActive` is the first visible Tab (first-visible fallback).
- [ ] `planClose` — close the last open Tab/Local Tab → `nextActive: null`, `clearActive: true`.
- [ ] `planClose` — close a non-active Tab → `nextActive: null`, `clearActive: false`, active surface unchanged.
- [ ] `planClose` — `closedEntry` carries the closed Tab's `{ kind, url }`.
- [ ] `planClose` — closing a Tab held by a Pin reports the Pin revert directive; closing an unlinked Tab does not.
- [ ] `planClose` / `planSwitch` — input `order`, `tabs`, `locals`, `pins` arrays are not mutated (referential check).
- [ ] `planSwitch` — moves an existing `ActiveRef` to most-recent; activating a fresh ref appends it.

### Layer 2 — Manual smoke (CDP/IPC)

Steps to manually verify with a live Remote Browser:

- [ ] Open three CDP Tabs, activate them in order, close the Active Tab → the previously-active Tab (MRU, not list-next) becomes the Active Tab.
- [ ] With one CDP Tab and one Local Tab open and the CDP Tab active, close the CDP Tab → the Local Tab becomes active (cross-kind MRU fallback).
- [ ] Close every Tab and Local Tab one by one → after the last close the chrome shows the empty state (no Active Tab, screencast cleared).
- [ ] Close a Tab that a Pin holds → the Pin reverts to unlinked and stays in the Pinned section; its saved title/URL are intact.
- [ ] Cmd+Shift+T after a mixed sequence of CDP/Local closes → reopens the most recently closed of either kind in its original kind (Closed Tabs ordering preserved through the new planner path).

### Layer 3 — Visual review

- [ ] Screenshots captured via Chrome MCP against `pnpm dev`
- [ ] All four states visible: loading, empty, error, populated
- [ ] Sidebar active highlight follows the planner's `nextActive` exactly across CDP-only, Local-only, and cross-kind close sequences (no stale or double highlight, no flicker on the empty → first-frame transition).

## Design notes

Describe the behavioral change, not the implementation path. Reference types, interfaces, and module contracts — not file paths or line numbers.

- **Contracts changed:** none of the existing module contracts change. `tab-lifecycle.ts` is a new *consumer* of `ActiveRef`/`mostRecent`/`dropActive`/`touchActive` (Active Order), `ClosedEntry`/`ClosedKind` (Closed Tabs), and `Pin`/`pinForTarget` (Pins). `app.tsx`'s internal close/switch handlers change from hand-rolled per-kind logic to applying a returned directive — an `app.tsx`-local refactor, not a public contract change.
- **New modules:** `src/lib/tab-lifecycle.ts` — one place that turns "a Tab/Local Tab closed" or "a surface activated" into a directive, composing Active Order + Closed Tabs + Pins so the close-fallback protocol has locality and a unit-test seam. Stays pure per the `src/lib/` invariant (effects live in `app.tsx`).
- **New ADR needed?** no — this consolidates existing modules behind one pure planner with no new architectural decision; it preserves ADR-0004 (Pin live-tab model) by surfacing the Pin-revert directive rather than performing it.

The planner reads the world as plain snapshots and returns a directive; `app.tsx` owns every effect (IPC to close the target, swap the Active Tab, push the Closed Tabs entry, revert the Pin, persist). `nextActive` of `null` is disambiguated by `clearActive`: `false` means "leave the current Active Tab alone" (a non-active Tab closed), `true` means "there is nothing left to show".

```ts
import type { ActiveRef } from "./active-order"
import type { ClosedEntry } from "./closed-tabs"
import type { Pin } from "./pins"
import type { LocalTab } from "./local-tabs"

interface CloseInput {
  kind: "cdp" | "local"
  id: string            // closed Tab targetId or Local Tab id
  url: string           // for the ClosedEntry
  wasActive: boolean
  order: ActiveRef[]    // Active Order (MRU), already excluding nothing
  tabs: { id: string; url: string }[]   // visible CDP Tabs in stable order (linked-to-pin already hidden)
  locals: LocalTab[]    // Local Tabs in their section order
  pins: Pin[]           // to detect a Pin holding the closed target
}

interface CloseDirective {
  closedEntry: ClosedEntry
  nextActive: ActiveRef | null
  clearActive: boolean
  revertPin?: Pin       // present when the closed CDP Tab was Pin-held
}

declare function planClose(input: CloseInput): CloseDirective
declare function planSwitch(order: ActiveRef[], ref: ActiveRef): ActiveRef[]
```

`planSwitch` is a thin, named wrapper over `touchActive` so the activation path and the close path read from the same module and the same vocabulary; it exists to give the switch protocol a home next to the close protocol rather than to add behavior.

## Out of scope

- No change to the Closed Tabs reopen mechanics, the Active Order primitives, or the Pins link-resolution logic — this task only *composes* them.
- No change to how a switch is performed at the IPC/Remote Page layer (activate target → reconnect screencast); only the MRU bookkeeping moves into `planSwitch`.
- No change to Tab drag-reordering, the `reconcile` merge, or stable ordering ownership.
- No new persisted settings, no UI-visible behavior change beyond correctness of which Tab becomes active.
- Not refactoring `main.js`/`server.mjs` — the planner is renderer-side only.

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
- [ ] Task closed: status → done, file moved to `docs/tasks/done/`, t024 in commit

## Notes

The planner is a deep module behind a shallow seam: a wide internal protocol (MRU across kinds, first-visible fallback, Pin revert, exhaustion) behind a two-function surface. Keep effects out — the `src/lib/` invariant is that these modules are pure and `app.tsx` drives the side effects. When updating CLAUDE.md, add `tab-lifecycle.ts` to the `src/lib/` module list and note that it composes Active Order + Closed Tabs + Pins. Watch the empty → first-frame transition during Layer 3 so the active highlight doesn't flicker when `clearActive` flips and a new Active Tab connects.

---

_When task status flips to `done`, move this file to `done/`._
