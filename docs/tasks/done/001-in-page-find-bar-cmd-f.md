# 001 — in-page find bar (Cmd+F)

- **Status:** done
- **Mode:** HITL
- **Estimate:** 1d
- **Slice:** 4-table-stakes-latency
- **Ring:** inner
- **Depends on:** none
- **Blocks:** none

## Goal

Cmd+F today fires `window.find(prompt('Find in page:'))` against the remote page over `Runtime.evaluate` — a single `prompt()` dialog. That dialog is a **no-op in a standalone iPad PWA** (the primary surface) and clunky on desktop: there is no match count, no next/prev, no way to dismiss without re-prompting, and no touch affordance at all. Find-in-page is effectively unavailable where it matters most. After this task, Cmd+F opens a proper **in-page find bar** — an input with a live match count ("3/12"), next/prev controls, and Esc-to-close — overlaid above the screencast canvas, that drives find on the **remote** page over CDP. The `prompt()` path is gone. A pure find-state reducer (`src/lib/find-bar.ts`) owns the query / current-match / total / open-close state under strict TDD; the remote-side search is a new Remote Page find intention; the bar is reachable without a keyboard via a toolbar affordance, so the iPad PWA finally gets working find-in-page.

## Why now

Find-in-page is **table-stakes** browser behavior, and it is currently **broken on iPad**: `prompt()` is blocked / silently dropped in a standalone-display PWA, so the daily-driver surface (the [web PWA on iPad](../memories/) is the priority surface) has no find at all. It is an **inner-ring** obligation for v0.1.0 — the bar a user reaches for the moment they want to locate text on a long page (a Teams thread, an Outlook message, a doc) and find nothing happens. Keyboard users reach it via Cmd+F; touch users reach it via a toolbar affordance now and the command palette later (**t058**, which adds the palette entry but reuses this task's open action, not the other way around). This unblocks "I'd want to use this all day" by closing one of the most visible gaps between this app and a real browser.

## Acceptance criteria

- [ ] Cmd+F opens the find bar and **focuses the input** (cursor ready, no extra click). Cmd+F again while open re-focuses/selects the input rather than toggling it shut.
- [ ] Typing a query **searches the remote page** over CDP — matches are found and the first match is revealed/highlighted on the live page.
- [ ] **Next / prev** controls (and Enter / Shift+Enter while the input is focused) cycle through matches and **wrap** at the ends (last → first, first → last).
- [ ] A **match count** is shown in the bar ("3/12"); an empty query shows no count, a query with no matches shows a clear **no-match** state ("0/0" or "No results", not a silent blank).
- [ ] **Esc** and a visible **close button** dismiss the bar, clear the query, and **clear any highlights/selection** left on the remote page.
- [ ] The implementation does **NOT** use `prompt()` anywhere — the old `window.find(prompt(...))` call is removed.
- [ ] The bar is **reachable without a keyboard**: a toolbar affordance opens it, and every interactive control in the bar (input, next, prev, close) has a touch target **≥ 44pt**.
- [ ] The bar is an **overlay above the screencast canvas** — it stacks over the live page via z-index (the same overlay-stacking discipline as dialogs / the settings sheet / local webviews), and never freezes or is occluded by the canvas.
- [ ] The **CDP find mechanism is decided and documented** in this spec's design notes (the remote-page search contract — query / next / prev / clear — not a fragile inline expression), and it returns a match count back to the bar so the count is real, not faked.
- [ ] Behavior with an empty / closed bar is unchanged: no overlay drawn, no input forwarding intercepted, the page behaves exactly as today.

## Test plan

Per [../conventions/tdd.md](../conventions/tdd.md): the find-state reducer is pure logic → strict TDD (Layer 1). The remote-side search over CDP is CDP/JS-injection glue → HITL smoke against a live page (Layer 2). The bar UI + overlay stacking + touch targets are a renderer change → visual review (Layer 3).

### Layer 1 — Pure logic (TDD)

- [ ] `find-bar.ts` — `open()` / `close()` transitions: open is closed→open with empty query and focus-intent; close resets query, current index, and total to the closed/zero baseline.
- [ ] `find-bar.ts` — `setQuery(q, total)` records the query and the reported total, and clamps the current index into `[0, total)` (or the no-match zero state when `total === 0`).
- [ ] `find-bar.ts` — `next()` / `prev()` advance the current index and **wrap** at both ends (last→first, first→last); no-op (or stay at the zero state) when `total === 0`.
- [ ] `find-bar.ts` — the displayed counter derives correctly: 1-based "current/total" for matches, the no-match state for `total === 0`, and nothing for an empty query.
- [ ] `find-bar.ts` — the module is pure: no `document`, no `window.find`, no CDP/transport calls, no timers; it is a state machine over `(state, action)` → `state`, and the effectful search is enacted by the caller.

### Layer 2 — Manual smoke (CDP/IPC)

HITL — needs a live Remote Browser via `pnpm web` (the iPad PWA path is the one that was broken; verify there as well as desktop web).

- [ ] Connect to the Host; open a long text page; press Cmd+F — the bar appears and the input is focused.
- [ ] Type a word that occurs several times — the first match is revealed on the remote page and the count shows "1/N".
- [ ] Click / tap **next** repeatedly — the selection advances match-to-match and **wraps** back to the first after the last; **prev** wraps the other way.
- [ ] Press **Esc** (and separately, tap the **close** button) — the bar disappears and **no highlight/selection remains** on the remote page.
- [ ] Type a word that does not occur — the bar shows the **no-match** state (not a silent blank), and no stale highlight from a prior query lingers.
- [ ] On the **iPad PWA** (standalone), open find via the **toolbar affordance** (no hardware keyboard) and run the same search/cycle/close — confirm it works where `prompt()` did not.

### Layer 3 — Visual review

- [ ] Screenshots via Chrome DevTools against `pnpm web` running locally, all four bar states: **empty query** (just opened), **no-match** (query with zero results), **matches** (query with "3/12" count), and **closed** (no overlay drawn).
- [ ] **Overlay stacking** verified — the bar sits above the screencast canvas and above other live content, and is not clipped by the canvas or the toolbar.
- [ ] **Touch targets** verified — input, next, prev, and close each render ≥ 44pt hit areas at the iPad sidebar/toolbar sizing.
- [ ] The bar matches the app's shadcn (radix-nova / HugeIcons / Manrope) styling and reads as part of the toolbar/overlay family, not a foreign widget.

## Design notes

Find splits into a **pure reducer** (query / current / total / open-close) and an **effectful remote search** (a new Remote Page intention that injects into the live page over CDP). The bar component owns presentation + focus; it asks the reducer "what is the state" and asks the Remote Page "do the search / step / clear", feeding the reported match count back into the reducer. This matches the project's pure-advisor / effectful-executor discipline (same shape as `tab-lifecycle.ts` → `app.tsx`).

- **`src/lib/find-bar.ts`** *(new)* — the only new pure module. A small state machine: `reduce(state, action) → state` over `{ open, query, currentIndex, total }`, with `open` / `close` / `setQuery` / `setTotal` / `next` (wrap) / `prev` (wrap) actions and a derived counter (1-based "current/total", no-match, or empty). No I/O — no `document`, no `window.find`, no transport. Justified as its own module so the cycle/wrap/clamp logic is exercised without a live page, and so t058 (command palette) can drive the same open action without touching CDP. Tested by `find-bar.test.ts`.
- **`src/components/find-bar.tsx`** *(new)* — the overlay bar: a focus-managed input, a "current/total" count, next/prev buttons, and a close button, built from the existing shadcn primitives (Button + HugeIcons). It renders **above the screencast canvas via z-index** — the same in-DOM overlay discipline that lets dialogs / the settings sheet / `local-webviews.tsx` stack over the live page (no native z-order; see ADR-0005). Touch targets ≥ 44pt. It holds the reducer state, drives the Remote Page find intention on query/next/prev/close, and writes the returned match count back into the reducer.
- **Remote Page find intention** *(extends `RemotePage`)* — the remote-side search is the hard part and lives behind a named intention, **not** a fragile inline expression at the call site. The contract: `find(query) → Promise<{ total: number }>` (search + reveal first match), `findStep(dir: "next" | "prev") → Promise<{ index: number }>` (advance + reveal), and `clearFind()` (drop highlights/selection). **CDP mechanism:** the intention injects a small find routine via `Runtime.evaluate` against the remote document — a per-document JS find/highlight helper that searches the DOM, counts matches, reveals/scrolls the current one into view, and reports `{ total, index }` via `returnByValue` (the same `Runtime.evaluate` + `returnByValue` pattern `copySelection` / `isLoading` already use). `window.find` alone is insufficient because it returns only a boolean and can't report a count or wrap deterministically, so the routine owns counting + stepping + clearing. (If the injected routine grows non-trivial, it lands as an `inject/` script à la the notification capture scripts, injected on demand rather than at document-start — decided during implementation; the intention contract above is stable either way.)
- **Cmd+F handler in `app.tsx`** — the existing `case "f"` keydown that calls `Runtime.evaluate` with `prompt(...)` is **removed** and replaced by opening the find bar (dispatch `open` to the reducer / set the bar-open state). Cmd+F-while-open re-focuses rather than toggles. The handler no longer talks to CDP directly — it only opens the bar; the bar owns the search.
- **`src/components/toolbar.tsx`** — gains a find affordance (a search/magnifier HugeIcon button) so touch users can open the bar without a keyboard. It calls the same open action the Cmd+F handler does. New prop `onOpenFind: () => void` on `ToolbarProps`.

- **Contracts changed:** `RemotePage` (in `remote-page.ts`) — **add** `find`, `findStep`, `clearFind` intentions (additive; existing intentions untouched). `ToolbarProps` — **add** `onOpenFind`. No change to the `Transport` seam (find rides the existing `send` / `invoke`), no change to `RemotePageEvent`.
- **New modules:** `src/lib/find-bar.ts` (pure find-state reducer) and `src/components/find-bar.tsx` (the overlay bar). Optionally an `inject/` find routine if the injected JS grows past an inline expression — same family as the notification capture scripts.
- **New ADR needed?** No. This rides the established single-Remote-Page model (ADR-0001 — find is one more named intention on the one live page) and the in-DOM overlay-stacking discipline (ADR-0005 — overlays stack above the live surface via z-index). No new architectural decision.

```ts
// pure reducer — no I/O; the caller enacts the search and feeds back `total`
interface FindState {
  open: boolean
  query: string
  currentIndex: number // 0-based; meaningless when total === 0
  total: number
}
type FindAction =
  | { type: "open" }
  | { type: "close" }
  | { type: "setQuery"; query: string }
  | { type: "setTotal"; total: number } // result of the remote search
  | { type: "next" } // wraps
  | { type: "prev" } // wraps

function reduce(state: FindState, action: FindAction): FindState
// "3/12" | "No results" | "" — derived, 1-based for display
function counterLabel(state: FindState): string

// new Remote Page intentions (effectful, injected via Runtime.evaluate)
interface RemotePageFind {
  find(query: string): Promise<{ total: number }>
  findStep(dir: "next" | "prev"): Promise<{ index: number }>
  clearFind(): void
}
```

## Out of scope

- **Full browser find parity** — regex, whole-word, and a case-sensitivity **toggle UI** are out (case handling can be minimal / fixed-default for v1). Capture as a follow-up if wanted.
- **Find across local tabs** (Electron `<webview>` guests) — local tabs are real pages with their own native find surface; this task is the **CDP screencast** page's find only.
- **The command palette entry** for find — that is **t058** (it reuses this task's open action; the palette wiring itself is not done here).
- **Persisting the last query** across opens / sessions, and any "highlight all matches at once" styling beyond revealing the current match — not required for v1.

## Definition of Done

All must be true before status → done.

- [ ] Layer 1 tests written and green (the `find-bar.ts` reducer: open/close, setQuery clamp, next/prev wrap, counter derivation, purity)
- [ ] Layer 2 smoke checklist completed with a live Remote Browser via `pnpm web` — including the **iPad PWA** path where `prompt()` was broken
- [ ] Layer 3 screenshots captured and committed (empty / no-match / matches / closed; overlay stacking; ≥44pt touch targets)
- [ ] `pnpm check` clean (Biome — lint + format)
- [ ] `pnpm typecheck` clean
- [ ] `pnpm test` green
- [ ] `pnpm web` boots cleanly and find-in-page works end-to-end (search, cycle, wrap, clear) with no `prompt()` anywhere
- [ ] CLAUDE.md updated for any modified module (`src/lib/CLAUDE.md` notes the new `find-bar.ts` and the `find`/`findStep`/`clearFind` Remote Page intentions; the root CLAUDE.md file-structure list gains `find-bar.ts` / `find-bar.tsx`)
- [ ] ADR written if an architectural decision was made (expected: none — rides ADR-0001 + ADR-0005)
- [ ] No commented-out code, no `console.log` debris, no AI attribution
- [ ] Task closed: status → done, file moved to `docs/tasks/done/`, t001 in commit

## Notes

- The old call to beat: `case "f"` in `app.tsx`'s keydown handler runs `window.cdp.send("Runtime.evaluate", { expression: "window.find(prompt('Find in page:') || '')" })`. The `prompt()` is the iPad failure — it returns nothing in a standalone PWA, so find silently does nothing. Removing it is half the value of this task.
- `window.find` returns only a boolean — it cannot report a count or step deterministically. The injected routine must own match counting, current-index stepping (with wrap), reveal/scroll-into-view, and a clean clear; report `{ total, index }` back via `returnByValue`. Treat the inline `navigateSpa` / `openTeamsThread` expressions as the precedent for "a small injected routine behind a named intention", not as a license to inline a fragile expression at the call site.
- Keep the bar's input out of the Input Forwarding path while it is focused — keystrokes typed into the find input must not be forwarded to the remote page as page input (the same care the URL bar takes: it stops propagation / checks the focused element before forwarding).
- ≥44pt touch targets are an iPad obligation — the toolbar's `icon-xs` buttons may be too small for the bar's controls; size the bar's next/prev/close for touch, not for the desktop toolbar density.
- "Reveal the current match" means scroll-into-view + a visible selection/highlight on the remote page — verify it actually moves the live viewport to the match, not just that the count is right.

---

_When task status flips to `done`, move this file to `done/`._
