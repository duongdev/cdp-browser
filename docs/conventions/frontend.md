# Frontend stack & implementation patterns

The implementation playbook for the renderer (`src/`). Companion to [ux.md](ux.md) (which covers interaction model) — this doc covers *how we build*.

## Stack at a glance

| Layer | Pick | Notes |
|---|---|---|
| Build | **Vite 8** | Fast HMR; minimal config in `vite.config.ts` |
| Framework | **React 19** | Stable modern hooks |
| Language | **TypeScript 5** | Strict, no `any` |
| Styling | **Tailwind 4** | CSS-first config (`@theme inline`); no `tailwind.config.js` |
| UI primitives | **shadcn/ui** | Owned in `src/components/ui/`; installed via CLI |
| Icons | **HugeIcons** (`@hugeicons/react`) | Not lucide-react |
| Fonts | **Manrope Variable** (sans) + **DM Mono** (mono) | Load via CSS |
| State | **Zustand** | UI state; one store per concern |
| Hotkeys | **hotkey-registry** + `⌘K` palette + `?` overlay | Adopt on touch; see [ux.md](ux.md) |
| Forms | **react-hook-form + Zod** | Defer until a screen needs it |
| Tests | **Vitest** (logic) + Chrome MCP visual review | See [tdd.md](tdd.md) |

**Not used and why:**

- **TanStack Router** — there are no routes. CDP Browser is a single-window Electron app; navigation is tab-switching, not URL routing. `app.tsx` owns the single view.
- **Apollo / GraphQL codegen** — data comes from the Electron main process over IPC, not from a GraphQL API. The IPC bridge (`window.cdp`) is the data layer.
- **react-i18n / i18next** — English only. No i18n infrastructure needed.
- **react-virtual** — defer until a list actually has enough items to cause perf problems. The tab sidebar is unlikely to exceed 20-30 items; virtualize only if profiling shows a real win.

---

## shadcn first

**Rule:** before building a UI component, check the shadcn registry. Reuse over re-invent.

### Order of preference

1. **Official [shadcn/ui](https://ui.shadcn.com/) registry** — `pnpm dlx shadcn@latest add <component>`. Owned components, fully customizable.
2. **Reputable ecosystem registries** — `aceternity`, `magicui`, etc. Prefer ones built on shadcn primitives so they share the design system.
3. **Compose from shadcn primitives** — when no off-the-shelf component fits, build from `Button`, `Input`, `Dialog`, `Popover`, `Command`, etc.
4. **Build from scratch** — only when the above don't apply *and* the component is reusable. One-off layout glue can stay inline.

### Discipline

- Keep shadcn components in `src/components/ui/`. Don't move or rename them — keeps the `shadcn add/diff` workflow clean.
- If you customize a shadcn component, add a comment at the top of the file explaining the divergence so future-you can rebase.
- Don't add a UI dependency that brings its own design system (Material, Chakra). One design system per app.
- **Always add shadcn components via the CLI, never by hand.** If the registry has it, install it.

### Custom components

Anything reusable goes in `src/components/<component>.tsx`. **Files are kebab-case; exports are PascalCase.**

```
src/components/
├── ui/                          shadcn primitives
├── sidebar.tsx                  exports Sidebar
├── toolbar.tsx                  exports Toolbar
├── viewport.tsx                 exports Viewport
├── status-bar.tsx               exports StatusBar
├── notification-bell.tsx        exports NotificationBell
├── settings-dialog.tsx          exports SettingsDialog
├── new-tab-dialog.tsx           exports NewTabDialog
└── add-bookmark-dialog.tsx      exports AddBookmarkDialog
```

Co-locate tests (`*.test.tsx`) for components with non-trivial logic; visual review is sufficient for layout-only components.

---

## State: Zustand for UI state

**IPC is the data layer.** Zustand is for UI-only state that doesn't live in the main process. Don't conflate them.

### IPC (server state)

- All Remote Browser data (tabs, URL, loading state, notifications, settings) comes from the main process via `window.cdp` IPC calls.
- Load settings and tab list via `ipcMain.handle` round-trips; subscribe to pushes via `ipcMain.on` event registration.
- No caching layer — IPC is fast enough that stale state is worse than a direct call.

### Zustand stores (client state)

One store per concern. Examples:

- `usePaletteStore` — `⌘K` command palette open/closed state, search query
- `useShortcutHelpStore` — `?` overlay visible/hidden
- `useThemeStore` — if extracted from `app.tsx`

Stores are small, single-responsibility, typed. Store files: `src/stores/<name>.ts`, exporting `use<Name>Store`.

**Anti-patterns:**
- **A single `AppStore` with everything.** Currently `app.tsx` holds most state as `useState` — that's fine for now. Extract to Zustand when state needs to be shared across more than one subtree or persisted independently.
- **Zustand mirroring IPC state.** Two sources of truth waiting to disagree. IPC state stays in the component tree via `useState` or hoisted to `app.tsx`.

---

## Hotkey registry, `⌘K` palette, and `?` overlay

These three features are adopted together on first touch — don't add one without the others.

### Why together

The `?` overlay and `⌘K` palette must draw from the same source of truth as the registered shortcuts. If they're separate lists, they drift. The hotkey registry is that single source.

### Conventions

- **Every keyboard shortcut goes through the registry.** No bare `window.addEventListener("keydown", ...)` for application shortcuts.
- **Every registration includes a `meta` label** so the action shows up in the palette and the `?` overlay with a human name.
- **Scope shortcuts to their pane.** Pass a `target` ref for shortcuts that should only fire when a specific area has focus (e.g. `j`/`k` only in the tab sidebar).
- **`enabled` for conditional registration** — disable when a modal is open; the registry tracks the disabled state so the overlay can hide suspended shortcuts.
- **`formatForDisplay`** for every `<kbd>` in the UI — renders `⌘K` on macOS, `Ctrl+K` elsewhere.

See [ux.md](ux.md#standard-shortcuts) for the full shortcut table.

---

## Visual quality: pixel-perfect, no jiggling

- **Layout shift forbidden.** Reserve space for everything that loads (skeletons, fixed dimensions, `aspect-ratio` for the screencast canvas).
- **Loading / empty / error / not-found states are designed** — see [State coverage](#state-coverage) below.
- **Transitions are deliberate.** Default to no animation. When you add one, it conveys information (tab switch blur, first-frame clear).
- **Spacing and borders from the design system.** No magic `px` values; use Tailwind's spacing scale.
- **Focus rings always visible.** shadcn handles this; don't override.

---

## Instant UI

**Loading states are a fallback, not a strategy.** The user-perceived speed of the app is the product.

### 1. Preload — fetch before the user asks

- Call `window.cdp.getTabs()` on startup before the user switches tabs.
- Prefetch bookmark favicons on idle.
- On tab switch, send the activate call immediately (before the WS reconnects) so the remote browser starts rendering the new page without waiting for the renderer to catch up.

### 2. Skeleton over spinner

A skeleton commits to layout. A spinner says "wait" and hides what's coming. Default to skeletons. Use spinners only for in-flight indicators on a known element (a button, an inline send icon) where layout is already settled.

### 3. Optimistic updates for local-effect actions

For actions with a predictable local effect (mark tab active → update sidebar immediately; toggle setting → apply immediately), update the UI state in the same frame as the user action. Reconcile with the IPC response when it arrives. If it errors, revert and surface a toast with a retry.

### Anti-patterns

- **Blocking the entire UI on a non-critical IPC round-trip.** Kick off the call; render the optimistic state.
- **Re-skeletoning on repeat visits.** If the data is in state, render it. Don't flash a skeleton on every tab switch.
- **Optimistic update without a revert path.** If the main process can reject, the UI must roll back gracefully.

---

## State coverage

Every screen, list, and async block must visibly handle four states. **No exceptions, no silent `null` returns.**

| State | When | What renders |
|---|---|---|
| **Loading** | Connecting to Remote Browser, waiting for first tab list | Skeleton or "Connecting…" pill |
| **Empty** | Connected but no tabs, empty bookmarks list | Placeholder with a clear next action |
| **Error** | CDP connection failed, IPC error | Recovery path explicit (retry button, settings link). Never a raw stack trace. |
| **Not found** | Deep-linked tab ID no longer exists | Distinct from empty. Offer "Back" + reason. |

### Shared state components

These live in `src/components/state/` (build on demand; establish the API now):

- **`<EmptyState>`** — `icon`, `title`, `description`, `action` slot.
- **`<ErrorState>`** — `error: Error | string`, `onRetry?`. Renders a designed error block, never a raw stack.
- **`<Skeleton>`** — shadcn primitive, composed into route-specific skeletons that mirror the final layout's spacing.

If a screen's variant needs to deviate, **extend the shared component** (add a prop or variant) — don't fork it inline.

### Discipline at every layer

- Every `useEffect` that calls IPC handles loading, error, *and* the empty-data edge case. Never assume the response is non-null in the component body.
- Wrap top-level with `<ErrorBoundary>` so a crash in one component doesn't blank the whole window.

---

## Flow & resilience

User trust is built in the small moments: how fast a click feels, how recoverable a failure is, whether they ever feel stuck.

### Auto-reconnect "Reconnecting…" pill

The WebSocket to the Remote Browser can drop — network interruption, browser restart, host machine sleep. The user must never reach a dead end.

- On WebSocket disconnect, show an inline "Reconnecting…" pill in the toolbar or status bar — never a blank screen or a full error page.
- Retry with exponential backoff. Reuse the `connectId` guard in `main.js` to prevent stale reconnects.
- On reconnect, restore the last active tab and URL bar state. The user should not lose their place.
- A "Reconnect now" button is always available in the Settings drawer and the status bar for manual recovery.

### Retryable on failure

Every failure path that *could* be retried *must* offer a retry. The user must never feel stuck.

- CDP API failures (tab open, navigate) surface as a toast with a "Retry" action.
- Settings save failures surface inline with a retry.
- Never swallow a failure silently.

### Soft reload, never hard refresh

The user must never need to press Cmd+R to fix a stuck state. Cmd+R drops in-memory tab state, bookmarks, and the IPC connection — it's an admission the app failed.

- Build a "Reload connection" affordance in the Settings drawer.
- Auto-soft-reload on focus return after a long idle: re-fetch the tab list, re-establish the screencast.
- Dropped WebSocket auto-reconnects (above); the user sees the pill, never a blank.

---

## Mock-first UI

**Build every new screen or component with mocks first. Get visual approval. Then wire real IPC.**

A new UI area lands in three steps, in order:

1. **Layout + copy + interactions** — render with hardcoded data. Tab navigation works. Empty / loading / error states are designed. Visual review via Chrome MCP.
2. **Approval gate** — sign off on the mock. Copy, spacing, hierarchy, and affordances get nailed down here. Cheap to change.
3. **Wire data** — replace fixtures with IPC calls, handle loading and error states with the shared components from step 1.

The costly mistakes in UI — wrong hierarchy, wrong copy, missing empty state — are visible in mocks. Discovering them after wiring IPC triples the cost.

---

## Testing the frontend

See [tdd.md](tdd.md) for the three-layer model; frontend specifics:

- **Unit tests** (`*.test.tsx`) — Vitest + Testing Library. Test components with non-trivial logic in isolation with mocked IPC (`window.cdp` stubbed). Don't unit-test trivial layout; visual review covers those.
- **Zustand store tests** (`*.test.ts`) — state transitions, derived selectors, persistence.
- **Visual review** — Claude Code drives Chrome MCP against `pnpm dev`. Screenshots committed to the branch for PR review.

---

_Last revisited: 2026-05-23_
