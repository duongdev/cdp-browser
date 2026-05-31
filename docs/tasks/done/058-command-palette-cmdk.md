# 058 — add Cmd+K command palette, ? shortcut overlay, and touch launcher

- **Status:** done
- **Mode:** HITL
- **Estimate:** 1d
- **Ring:** outer
- **Slice:** 4-table-stakes-latency
- **Depends on:** none
- **Blocks:** none

## Goal

Add the `⌘K` command palette (shadcn `Command` / cmdk) and the `?` shortcut-help overlay that `ux.md` has mandated since day one but that does not exist yet, plus a toolbar **touch launcher** button that opens the palette without a keyboard. Both the palette and the overlay read from one new pure `hotkey-registry.ts` — a single list of registered actions (name, group, hotkey hint, run-fn) — so the palette is searchable and every entry shows its shortcut, and the overlay is auto-generated from the same source with zero drift. After this ships, an iPad user with no Magic Keyboard can reach every action (reconnect, reload, switch tab, open settings, toggle Adaptive Viewport / notifications, copy address) by tapping one button, and a keyboard user gets the Arc/Raycast `⌘K` muscle-memory entry point plus a self-updating `?` shortcut reference.

## Why now

This is the single biggest interaction-cost cut for a keyboardless iPad: the web PWA is the v0.1.0 release surface and the daily-driver target, and today every action is only reachable by hunting for its specific control or remembering an undocumented shortcut. A command palette collapses that into one tap-or-type surface, and the `?` overlay makes the existing (but invisible) shortcut map discoverable. It also pays down a standing `ux.md` debt — keyboard parity says "the palette doubles as a self-updating shortcut reference," which requires the registry this task introduces. It is **OUTER ring**: a fast-follow for v0.1.1, **not** a v0.1.0 tag-blocking gate. It depends on nothing and blocks nothing, so it can land any time after the inner ring without coordinating with the latency or shell tracks.

## Acceptance criteria

- [ ] `⌘K` (Linux/Windows `Ctrl+K`) opens the command palette from anywhere except while typing into an input/address bar that owns the key.
- [ ] The palette lists **every** registered action with its name, group, and — if it has one — its hotkey hint rendered as a `kbd` element.
- [ ] Typing filters actions by name (and group) case-insensitively; `↑`/`↓` move the selection; `↵` runs the highlighted action and closes the palette; `Esc` closes without running.
- [ ] `?` opens the shortcut-help overlay from anywhere (except while an input owns the key); `Esc` closes it. The overlay is **generated from the same `hotkey-registry.ts`** — adding an action with a hotkey makes it appear in both the palette and the overlay with no second edit.
- [ ] The overlay is grouped by category (Global / Tab navigation / Sidebar / Address bar), matching the `ux.md` standard-shortcut tables.
- [ ] A toolbar **touch launcher** button (icon-only, `aria-label`) opens the palette on tap; it is reachable with a finger only (no keyboard), and its hit target is ≥44pt on a coarse pointer (per t048 / `ipad` convention).
- [ ] These existing actions are registered and runnable from the palette: Reconnect, Reload page, Open Settings, Open new tab, Close active tab, Reopen last closed tab, Toggle Adaptive Viewport, Toggle notifications, Copy address, plus "Switch to <tab/pin>" entries for each open tab and pin.
- [ ] Each registered action's run-fn invokes the **same** handler the existing hotkey/toolbar path already calls — no duplicated effect logic; the palette/overlay are presentation over the existing handlers.
- [ ] `hotkey-registry.ts` is pure: no React, no IPC, no DOM, no `window` — it builds and queries the action list as plain data; effects (run-fns) are injected by `app.tsx`.
- [ ] Opening/closing the palette restores focus to the element that opened it (or the viewport canvas), per the `ux.md` focus-restoration rule.

## Test plan

Which testing layers apply (see [../conventions/tdd.md](../conventions/tdd.md)) and what specifically is tested.

### Layer 1 — Pure logic (TDD)

Table-driven `hotkey-registry.test.ts`, written test-first against the pure registry module:

- [ ] `registerAction` / `buildActions` — an action added with a hotkey is present in the list with its name, group, and hotkey hint.
- [ ] `filterActions(query)` — case-insensitive substring match on name; empty query returns all; non-matching query returns none.
- [ ] `filterActions` — matching also works against group label (e.g. query "tab" surfaces Tab-navigation actions).
- [ ] `groupForOverlay` — actions partition into the `ux.md` categories (Global / Tab navigation / Sidebar / Address bar) preserving registration order within a group.
- [ ] `hotkeyHint` — an action without a hotkey reports no hint (palette renders nothing), one with a hotkey reports the display string (e.g. `⌘R`).
- [ ] purity — `buildActions` / `filterActions` do not mutate their inputs and never touch `window`/DOM (referential + smoke check).

### Layer 2 — Manual smoke (CDP/IPC)

n/a — this task only touches the renderer (palette/overlay/registry/toolbar). It calls existing handlers; it adds no new main-process or IPC code. The run-fns are exercised in Layer 3 against a running renderer.

### Layer 3 — Visual review

- [ ] Screenshots captured via Chrome DevTools MCP against `pnpm dev` (desktop web is acceptable for the keyboard paths).
- [ ] `⌘K` opens the palette; the populated state shows grouped actions, each with its `kbd` hint; the empty-search state ("No results") renders cleanly with no layout shift.
- [ ] Running an action from the palette (e.g. Open Settings, Reload, Switch to a tab) performs the action and closes the palette; focus returns to the prior element.
- [ ] `?` opens the overlay; categories render in `ux.md` order; `Esc` closes both palette and overlay; focus is restored.
- [ ] Tapping the toolbar touch launcher opens the palette (verified with a coarse-pointer emulation in DevTools; **HITL** for real-finger confirmation on iPad — fold into t018's couch-verification pass).
- [ ] `prefers-reduced-motion` respected — palette open/close has no jarring motion when the system preference is set.

## Design notes

Describe the behavioral change, not the implementation path. Reference types, interfaces, and module contracts — not file paths or line numbers.

- **Contracts changed:** none of the existing module contracts change. A new pure `hotkey-registry.ts` introduces an `Action` shape and pure builders/queries; `app.tsx` builds the concrete action list by injecting its existing handlers (the same callbacks the current `keydown` `switch` and the toolbar buttons already invoke) and feeds it to the palette and overlay components. The existing global `keydown` handler stays the source of truth for raw key→action dispatch; the registry adds `⌘K` and `?` openers and the run-fn metadata the palette/overlay need. No effect logic is duplicated.
- **New modules:**
  - `src/lib/hotkey-registry.ts` — pure action registry: an `Action` is `{ id, name, group, hotkey?, run }` (effects injected), and the module exposes `buildActions`, `filterActions(query)`, and `groupForOverlay` so the palette and the `?` overlay share one source of truth. Stays pure per the `src/lib/` invariant — `app.tsx` owns the side effects.
  - `src/components/command-palette.tsx` — shadcn `Command` (cmdk) dialog driven by the registry's filtered actions; opens on `⌘K`/touch launcher, runs the highlighted action's run-fn, restores focus on close.
  - `src/components/shortcut-overlay.tsx` — `?`-triggered help dialog rendering `groupForOverlay(actions)` as the `ux.md` categories with `kbd` hints.
- **Touched components:** `src/components/toolbar.tsx` gains the icon-only touch launcher button (HugeIcons, `aria-label`, ≥44pt coarse-pointer hit target) that opens the palette. `src/app.tsx` owns palette/overlay open state, builds the injected action list from its existing handlers, and wires `⌘K`/`?` into the existing global `keydown` path (gated so an input that owns the key still wins, mirroring how the current shortcut `switch` already guards typing surfaces).
- **shadcn:** add the `command` primitive via the shadcn CLI (radix-nova preset, owned locally under `components/ui/`) — do not hand-roll cmdk. Verify the current `Command`/`cmdk` API against shadcn docs before wiring.
- **New ADR needed?** no — this implements a long-standing `ux.md` mandate with existing primitives; it introduces no new architectural decision. It references `ux.md` (command palette + `?` overlay + keyboard parity) and honors the `src/lib/` purity invariant and t048/`ipad` hit-target rules.

```ts
// the registry's shape — effects are injected, never imported
interface Action {
  id: string
  name: string
  group: "Global" | "Tab navigation" | "Sidebar" | "Address bar"
  hotkey?: string // display string, e.g. "⌘R" — drives both the palette hint and the overlay row
  run: () => void
}

declare function buildActions(input: Action[]): Action[]
declare function filterActions(actions: Action[], query: string): Action[]
declare function groupForOverlay(actions: Action[]): Record<Action["group"], Action[]>
```

## Out of scope

- **No new hotkeys or new behaviors** beyond the `⌘K` and `?` openers — this task surfaces the actions that already exist; it does not invent commands or change any existing shortcut.
- **No general feature-gate framework** — the only caps-aware touch is hiding Electron-only actions (local tabs / extensions) on web via the existing `webCaps` flag, not a new abstraction.
- **No latency HUD** — that is t059 (outer ring), fed by t057 metrics; the palette does not expose perf controls.
- **No `app.tsx` effect-cluster extraction / god-component refactor** — deferred to v0.2; this task injects handlers, it does not restructure them.
- **No touch-input forwarding work** (touch-scroll-tap is t051); the touch launcher is just a tap-to-open button reusing the normal click path.
- **No fuzzy/scored search or recents/MRU ordering** in the palette — plain case-insensitive substring filter is enough for v0.1.1; richer ranking is a later refinement.

## Definition of Done

All must be true before status → done.

- [ ] Layer 1 tests written and green (`hotkey-registry.test.ts`)
- [ ] Layer 2 smoke — n/a (no main.js/IPC touched)
- [ ] Layer 3 screenshots captured and committed
- [ ] `pnpm check` clean (Biome — lint + format) for the files this task touches
- [ ] `pnpm typecheck` clean
- [ ] `pnpm test` green
- [ ] `pnpm dev` boots cleanly and the changed surface works end-to-end
- [ ] CLAUDE.md updated for any modified module (add `hotkey-registry.ts` to the `src/lib/` list; note `command-palette.tsx` / `shortcut-overlay.tsx` in the components list)
- [ ] ADR written if an architectural decision was made (not expected here)
- [ ] No commented-out code, no `console.log` debris, no AI attribution
- [ ] Task closed: status → done, file moved to `docs/tasks/done/`, t058 in commit

## Notes

The registry is a deep-ish module behind a shallow seam: a wide set of actions and groupings behind `buildActions` / `filterActions` / `groupForOverlay`, with all effects injected so the module stays pure and unit-testable without React. Keep the run-fns pointing at the **existing** handlers (`app.tsx`'s current shortcut `switch` cases and the toolbar callbacks) — the palette is presentation, not a second copy of the effect logic. Hide Electron-only actions (local tabs, extensions) on the web build via the existing `webCaps` flag rather than registering then disabling them. When adding the `command` primitive, pull it through the shadcn CLI (radix-nova) and confirm the cmdk API against current docs. For the touch launcher, reuse the t048 / `ipad`-convention ≥44pt coarse-pointer hit target and a HugeIcons glyph (not lucide). Real-finger confirmation on iPad is HITL — roll it into the t018 couch-verification pass rather than blocking this outer-ring task on hardware.

---

_When task status flips to `done`, move this file to `done/`._
