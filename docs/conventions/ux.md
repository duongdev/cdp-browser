# UX conventions

CDP Browser's primary user drives it as a daily browser replacement — opening tabs, navigating pages, managing bookmarks, reviewing notifications, adjusting settings. The UX optimization is **keyboard-first**: every action reachable from the keyboard should be. Mouse is the fallback, not the default.

This convention covers the *interaction model*. Implementation (state, components, hotkey registry) lives in [frontend.md](frontend.md). Visual quality discipline is summarized here and detailed in [product.md](product.md).

---

## Principle: keyboard parity

Every interactive action in the UI is reachable from the keyboard.

- If a button exists, it has a shortcut.
- If a list exists, you navigate it with `j`/`k` or arrow keys.
- If a panel has a primary action, a shortcut triggers it.
- If a modal opens, `Esc` closes it.
- If an input is the primary surface, `⌘↵` or `↵` submits.

The acid test: **you can open a tab, navigate to a URL, switch tabs, open settings, and close the app without touching the mouse.**

---

## Standard shortcuts

Naming follows mainstream tools (Arc, Linear, Raycast) so muscle memory transfers.

### Global

| Shortcut | Action |
|---|---|
| `⌘K` | Command palette (search, navigate, run any action) |
| `?` | Show keyboard shortcut help overlay |
| `⌘,` | Open Settings drawer |
| `⌘T` | Open new tab |
| `⌘W` | Close active tab |
| `⌘⇧T` | Reopen last closed tab |
| `⌘L` | Focus address bar |
| `Esc` | Close modal / clear address bar focus / cancel action |
| `⌘R` | Reload active Remote Page |

### Tab navigation

| Shortcut | Action |
|---|---|
| `⌘⌥→` / `⌘⇧]` | Next tab |
| `⌘⌥←` / `⌘⇧[` | Previous tab |
| `⌘1` – `⌘9` | Switch to tab by position |

### Address bar

| Shortcut | Action |
|---|---|
| `↵` | Navigate to typed URL or search |
| `Esc` | Cancel and restore previous URL |

### Sidebar (tab list)

| Shortcut | Action |
|---|---|
| `j` / `↓` | Next tab |
| `k` / `↑` | Previous tab |
| `↵` | Activate selected tab |

These sidebar shortcuts are scoped — they fire only when the sidebar has focus, never when an address bar or other input is active.

### Modifiers

- `⌘` on macOS = `Ctrl` on Linux/Windows. Use `Mod` in docs and `kbd` elements.
- Display modifier symbols on macOS (`⌘`, `⇧`, `⌥`); spell them out on other platforms.

---

## Command palette (`⌘K`)

Single entry point for everything. Patterned after Arc and Raycast.

**It can:**

- Navigate (`Switch to GitHub tab`, `Open bookmarks`)
- Run actions (`Reload`, `Close tab`, `Open Settings`)
- Toggle flags (`Toggle Adaptive Viewport`, `Toggle notifications`)
- Open URLs from bookmarks (`Open Linear`)

**Implementation:** shadcn `Command` primitive (which wraps `cmdk`). Each action registers with metadata: name, hotkey hint if any, icon, group, run-fn.

**Discoverable:** every action surfaced in the palette shows its hotkey. The palette doubles as a self-updating shortcut reference.

---

## Shortcut help overlay (`?`)

Press `?` from anywhere → overlay shows the shortcuts that apply in the current context. Categorized: Global / Tab navigation / Sidebar / Address bar.

**Auto-generated** from the same hotkey registry the palette uses. One source of truth → no documentation drift.

---

## Focus management

- **Visible focus rings always.** Don't strip the browser default outline without a clear replacement. shadcn handles this; don't override.
- **Focus traps in modals and drawers.** `Tab` cycles within. `Esc` closes and restores focus to the element that opened it.
- **Restore focus on close.** The element that opened a modal/drawer regains focus when it closes.
- **Address bar focus.** `⌘L` selects all text; `Esc` exits without navigating and returns focus to the viewport.
- **Viewport focus.** After navigation or tab switch, focus returns to the screencast canvas so keyboard events flow to the Remote Page without an extra click.

---

## Accessibility baseline (WCAG 2.1 AA)

Keyboard-first overlaps heavily with accessibility. Add:

- **Semantic HTML.** `<button>` not `<div onClick>`. `<nav>`, `<main>`, `<aside>` for layout regions.
- **ARIA only when necessary.** Native elements over `role="button"`. If you reach for ARIA, ask if a native element fits first.
- **Color contrast** ≥ 4.5:1 for text. shadcn's defaults pass; don't tint into failure.
- **Don't rely on color alone** to convey meaning (e.g. tab state). Pair color with icon or text label.
- **Screen reader labels** on icon-only buttons (`aria-label="Close tab"`, `aria-label="Open command palette"`).
- **Reduced motion** — respect `prefers-reduced-motion`. The Switch Effect (tab blur) must be suppressed or shortened when the system preference is set.

No mobile / touch targets needed — CDP Browser is a desktop Electron app.

---

## Reduce clicks

Every click is a chance to lose focus. Before adding one, ask if it's necessary.

- **Defaults that match intent.** If 90% of the time you want the same thing, make it the default — not a question.
- **Inline edit over modal.** The Settings drawer lets you edit host/port inline and commit on blur. A modal for a two-field form is overhead.
- **One-click primary actions** with an undo or cancel affordance. Switching tabs, reloading, opening bookmarks — no confirmation step.
- **Bundle related actions** when dual outcome dominates: "Save and reconnect" in Settings.
- **Keyboard for power users.** Every primary action has a shortcut (see above).

---

## Design & visual discipline

The bar is **product quality** ([product.md](product.md)). The implementation discipline lives in [frontend.md](frontend.md):

- No layout shift, designed loading/empty/error states, deliberate transitions: [frontend.md#visual-quality](frontend.md#visual-quality-pixel-perfect-no-jiggling)
- Design system and component sourcing: [frontend.md#shadcn-first](frontend.md#shadcn-first)
- State coverage (all four states): [frontend.md#state-coverage](frontend.md#state-coverage)
- Instant UI (preload, skeletons, optimistic): [frontend.md#instant-ui](frontend.md#instant-ui)
- Flow & resilience (reconnect pill, retryable, soft-reload): [frontend.md#flow--resilience](frontend.md#flow--resilience)

If a state, transition, or visual pattern isn't designed, it isn't done.

---

## Anti-patterns

- **Adding a button without a shortcut.** Every button has one or it's not a button — it's a "click-only edge case" that needs a design rethink.
- **Stripping the focus ring** because "it doesn't match the design." Add a custom one or don't strip it.
- **Drag-and-drop with no keyboard equivalent.** Tabs are drag-reorderable; they must also be reorderable via keyboard.
- **Modals that trap focus but don't restore it.** Annoys the user, breaks keyboard flow.
- **Toast notifications not dismissible with keyboard.** `Esc` should clear them.
- **Address bar that doesn't select-all on `⌘L`.** That's the standard; match it.

---

## Testing UX

The visual review layer ([tdd.md](tdd.md) layer 3) covers:

- Every shortcut from this doc is wired and triggers the right action.
- The shortcut overlay (`?`) renders the shortcuts that apply in context.
- The command palette finds every registered action.
- Keyboard navigation through sidebar, toolbar, and viewport works without focus leaks.
- Focus restoration on modal/drawer close.

---

_The fastest way to use a tool is the way you don't have to think about. Keyboard-first gets there._

_Last revisited: 2026-05-23_
