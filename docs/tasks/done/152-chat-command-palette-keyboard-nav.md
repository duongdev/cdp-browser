# 152 — teams chat: context-aware ⌘K palette + keyboard-first navigation

- **Status:** done
- **Mode:** TDD (pure modules) + manual/visual for the React wiring
- **Depends on:** t129 (list+thread), t142/t144 (react/edit/delete flows), t149 (design tokens — `--ring`), t150 (routing)
- **Workstream:** B + C (PSN-90 native chat UI enhancements) — built together, one shared registry

## Goal

Turn `/chat` keyboard-first: a context-aware ⌘K palette + Linear-style j/k navigation over the list
and thread, message actions on the focused message, and a `?` overlay — all through ONE pure command
registry consumed by both the palette and the overlay. Chat-only (grilled #6).

## Architecture (one registry, two consumers)

- `chat/src/lib/command-registry.ts` (pure, TDD) — the action list `{id,label,group,keys?,when(ctx),run}`
  where `ctx = {view, focusedConversationId, focusedMessageId, isOwnMessage, composerFocused}`.
  `buildActions` / `actionsForContext` / `filterActions` (diacritic-safe fuzzy via the existing
  `src/lib/fold-text.ts`, imported not copied) / `groupForOverlay`. Effects injected by chat-app.
- `chat/src/lib/chat-keys.ts` (pure, TDD) — `routeKey(e, ctx, pendingG)` → a `KeyIntent | null`.
  Guard: NO bare-char shortcut fires when a text field / contenteditable is focused (composer / edit
  box / palette input) or a chord modifier is held. **Esc is never claimed** — the palette, lightbox,
  and inline edit own Escape via their own handlers; routing it would fight them.
- Presentation mirrors the `/` build's proven pattern (not imported): `command-palette.tsx`
  (cmdk via shared `ui/command`, `shouldFilter={false}` so the registry filter is the single source)
  + `shortcut-overlay.tsx` (auto-generated via `groupForOverlay`).

## Wiring

`chat-app.tsx` holds the list cursor (`focusedConvId`), the active thread pane's imperative handle
(`ThreadHandle` — `focusNext/focusPrev/getFocused/command/isComposerFocused`), and its reported
focused message (`onFocusChange`). A global keydown listener calls `routeKey` and dispatches. Message
focus lives PER thread pane (each keep-alive pane keeps its own cursor); list focus lives in chat-app.
`e`/`⌫`/`r` route through the SAME inline edit/delete/react flows a click uses — delete goes through
the existing `AlertDialog` confirm, never bypassed.

## Binding table

| Key | Where | Action |
|---|---|---|
| `j` / `↓` | list / thread | focus next conversation / message |
| `k` / `↑` | list / thread | focus prev conversation / message |
| `Enter` | list | open focused conversation |
| `⌘K` / `Ctrl+K` | anywhere | command palette (context-aware) |
| `g` then `i` | anywhere | go to inbox/list (1s sequence window) |
| `e` | thread, own message | edit focused message |
| `⌫` / `Delete` | thread, own message | delete focused message (→ confirm dialog) |
| `r` | thread, focused message | open reaction bar |
| `?` / `⌘/` | anywhere | shortcut overlay (auto-generated) |
| `Esc` | — | owned by palette/lightbox/edit — never routed here |

Focus is visible (coral `--ring` token, keyboard-only — no ring on touch/mouse) and scrolls into
view (`scrollIntoView({block:"nearest"})`).

## Acceptance

- [x] ⌘K opens; actions filter by context (list → jump-to-conversation + nav + app; thread adds
      react/edit/delete on the focused message; dead entries excluded).
- [x] Jump-to-conversation switches panes instantly (keep-alive) + pushes the t150 route.
- [x] Keyboard-only operable end-to-end: ⌘K → type → Enter opens; j/k walks the list + thread.
- [x] Bare-char shortcuts suppressed while typing (composer/edit/palette input/contenteditable).
- [x] Esc not swallowed from palette/lightbox/edit flows.
- [x] `?` overlay lists every bound shortcut, grouped; auto-generated from the registry.
- [x] Focus visible (`--ring`) + scrolled into view; no ring until first keyboard use (touch safe).
- [x] Pure modules TDD'd; diff confined to `chat/**` + `docs/tasks/**`; `/` build byte-unchanged.

## Verification

`pnpm test` → 1419 passed (30 new: 22 registry + keys). `pnpm typecheck` clean. `pnpm chat:build`
clean. Diff confined to `chat/**`. Live-verified headless (screenshots): ⌘K opens the centered
palette, typing fuzzy-filters, Enter jumps + pushes the route; j/k rings + walks the list and
thread; Enter opens the focused conversation.

Two live-verify fixes:
- **Tailwind sources** — `vite.config.chat.ts` roots the build at `chat/`, and Tailwind v4
  auto-detects sources from the Vite root, so utilities used only in the shared
  `src/components/ui/*` (dialog overlay/positioning, `sr-only`, cmdk selectors) were never
  generated: the ⌘K dialog rendered unstyled and its sr-only header leaked as visible static text.
  Fix: `@source "../../src"` in `chat/src/index.css`.
- **view gating** — on the wide layout `view` was hardcoded `"thread"` even with no pane open, so
  j/k drove a null thread handle and the list cursor never moved. Fix: `view === "thread"` only
  when a thread is actually open and on screen.

## Deferred

- Real-device verification (iPad PWA + a physical keyboard).
- Search UI (`/`) — no search surface exists yet; skipped per the task (no dead binding).
- Palette entries for settings/mark-read/mute — owned by workstreams F/J/K, added when they land.
