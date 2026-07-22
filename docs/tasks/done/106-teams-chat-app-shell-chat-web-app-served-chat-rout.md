# 106 — teams chat app shell: chat/ web app + served /chat route + conversation-list UI

- **Status:** done
- **Mode:** HITL
- **Estimate:** 1d
- **Depends on:** t105 (cred mint + SQLite store + `GET /api/teams/conversations`)
- **Blocks:** t107+ (message read/thread, reply, rich compose)

## Goal

Stand up the **standalone Teams chat web app** as its own surface: a new `chat/` Vite app,
served by the extended `web/server.mjs` at same-origin path **`/chat`**, whose home screen
renders the live **conversation list** from t105's `GET /api/teams/conversations`. After
this ships, opening `<host>/chat` shows your real Teams 1:1 + group conversations (topic +
last-message preview), with honest loading / empty / error / populated states. No message
reading or reply yet — tapping a row is wired but inert (t107 fills the detail).

Epic context + the 13 locked decisions live in `docs/adr/0018-teams-chat-app.md` and the
teams-chat-app-epic memory. This is Ring-1 UI on top of t105's data spine.

## Why now

t105 proved the data path (creds → DB → `/api/teams/conversations`). Nothing is visible
yet. t106 makes the app real: a served, installable surface showing the conversation list.
It defines the app's structure (the flat-dir `chat/` decision) that every later UI task
builds in, so it should land before the message/reply/compose tasks.

## Scope

- **`chat/` web app** (flat dir, shares `core/` + the extended server — ADR-0018 decision 1):
  its own Vite entry (`chat/index.html` + `chat/src/main.tsx`), building to a dedicated
  output (e.g. `dist-chat/`) with a `pnpm chat:build` + `chat:web` script pair mirroring the
  existing `web` scripts. Reuse the existing renderer's design system (shadcn radix-nova ui,
  HugeIcons, Manrope/DM-Mono, Tailwind v4, `cn`) — share via a Vite alias into `src/` (or a
  shared `ui` path), don't fork the component library.
- **Served at `/chat`** (same origin — ADR-0018 decision 12): `web/server.mjs` serves the
  built chat bundle under `/chat` (static assets + SPA `index.html` fallback), path-scoped so
  it never collides with the existing `/` browser PWA. Its PWA manifest + service worker are
  scoped to `/chat` (own `start_url`/`scope`) so it installs as a distinct app.
- **Conversation-list UI** — a `ConversationList` reading `GET /api/teams/conversations`:
  rows show conversation label (topic, or the members for a DM) + last-message preview +
  relative time; unread hint if the shape carries it. Full **four-state coverage**
  (loading skeleton / empty / error-with-retry / populated), instant UI, kebab-case files,
  PascalCase exports. This is the left column of the eventual list+pane; the pane is t107.
- Tapping a row calls an `onOpenConversation(convId)` that is wired but a no-op placeholder
  for now (t107 renders the thread).

## Acceptance criteria

- [ ] `pnpm chat:build` produces the chat bundle; `pnpm chat:web` (or the shared `web`
      server) serves it at `/chat` with SPA fallback; `/` (browser PWA) is byte-unchanged.
- [ ] Visiting `/chat` fetches `GET /api/teams/conversations` and renders the real list.
- [ ] All four states render: loading skeleton, empty ("no conversations"), error + Retry,
      populated rows (label + preview + time).
- [ ] The chat app reuses the existing shadcn design system (no forked/duplicated ui lib).
- [ ] Its manifest + service worker are scoped to `/chat` and don't interfere with the `/`
      PWA's SW scope.
- [ ] Row tap invokes `onOpenConversation(convId)` (inert placeholder — no detail yet).

## Test plan

### Layer 1 — Pure logic (TDD)

- [ ] Any pure list-shaping helper (e.g. `conversationLabel(conv)` for DM-vs-group label,
      `previewLine(conv)`) gets a unit test. If the row is pure presentation over the API
      shape with no logic, state "n/a — presentational" and cover it in Layer 3.

### Layer 2 — Manual smoke (server)

- [ ] `pnpm chat:web` (or `web`) boots; `curl -I <host>/chat` → 200 HTML; a deep link like
      `/chat/anything` also serves the SPA index (fallback).
- [ ] `/` still serves the browser PWA unchanged.

### Layer 3 — Visual review (REQUIRED — this is a UI task)

- [ ] Screenshots against the running chat app of all four states (mock the fetch for
      empty/error/loading; real data for populated).
- [ ] List is legible + responsive at phone and wide widths.
- [ ] The orchestrator drives this via the running server + browser tooling before ship.

## Design notes

- **New surface:** `chat/` is a second frontend in the same flat repo (not a monorepo
  package — ADR-0008 defer stands). It shares `core/` + the server + the design system;
  it does NOT share the browser renderer's `app.tsx`/routing.
- **Build wiring:** the agent picks the cleanest second-Vite-entry approach (separate
  `vite.config.chat.ts` or a multi-page build) — the constraint is: `/` build unchanged,
  `/chat` build isolated, design system shared not forked. Document the chosen wiring in
  CLAUDE.md's File Structure + the web-build section.
- **Server:** add the `/chat` static+SPA serve alongside the existing `dist/` serve; keep it
  behind the same `caps.web` world (Electron thin shell is a fast-follow, out of scope here).
- **New ADR needed?** no — covered by ADR-0018.

## Out of scope

- Message read / thread view / the list+**pane** layout (t107).
- Reply / rich compose (t108+).
- The thin **Electron shell** loading `/chat` (fast-follow task — keep t106 to the web surface).
- Poll ingestion / realtime sync / unified push (t109/t113).
- Auth/login UI (tailnet-gated like the existing web build; the keeper mints creds headlessly).

## Definition of Done

- [ ] Layer 1 tests green (if any pure helper exists).
- [ ] Layer 2 smoke: `/chat` serves + SPA fallback + `/` unchanged.
- [ ] Layer 3 screenshots captured (all four states) and reviewed.
- [ ] `pnpm check` clean (touched files), `pnpm typecheck` clean, `pnpm test` green,
      `node --check web/server.mjs`.
- [ ] CLAUDE.md File Structure + web-build section updated for the `chat/` app + `/chat` route.
- [ ] No AI attribution, no console debris, no commented-out code.
- [ ] Task closed: status → done, moved to `docs/tasks/done/`, `t106` in the commit.

## Notes

- Reuse over rebuild: pull in the existing `src/components/ui/*` (shadcn radix-nova),
  `src/index.css` theme, and fonts — the chat app should look like the same product.
- Keep the conversation-list data-fetch behind a small typed client (`chat/src/lib/…`) so
  t107 (thread) + t109 (live sync) can extend it, not rewrite it.
- Worktree: 2-commit ship (code on feature branch, docs on main); never `git add -A`;
  `--no-verify` (rtk breaks the pre-commit hook). See the teams-chat-app-epic memory.
