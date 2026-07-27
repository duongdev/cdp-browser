# 174 — assistant panel UI: third column, useChat, citations, session picker

- **Status:** ready
- **Mode:** HITL
- **Estimate:** 1d
- **Depends on:** t173
- **Blocks:** t175, t176

## Goal

The assistant is usable in the chat app: a third column docked right of list+thread on wide viewports (full-screen stacked destination on phone), driven by `@ai-sdk/react` `useChat` against t173's stream route, rendering streamed markdown with citation chips that open the cited conversation in the main thread pane, with a session picker (list/switch/rename/delete) in the panel header and "Ask AI" entry points (header toggle, ⌘K, message-actions menu).

## Why now

First user-visible payoff of the epic; t175/t176 hang affordances off this panel.

## Acceptance criteria

- [ ] Panel: collapsible third column on wide (width persisted in prefs, toggle in header + ⌘K); phone/narrow → full-screen view in the existing stacked navigation; Electron shell unaffected structurally (same web build).
- [ ] `useChat` + `DefaultChatTransport` → `POST /api/chat/assistant/:sessionId`; streamed tokens render live; tool-call steps visible as a subtle "searching…" state.
- [ ] AI Elements adopted selectively via shadcn registry into `chat/src/components/ai/` (Conversation, Message, Response, PromptInput, Reasoning/Sources as needed) — each file audited for Next-only imports, inherits radix-nova theme; streaming markdown via the bundled streamdown path.
- [ ] Assistant output renders through a sanitize boundary consistent with `sanitize-message.ts` (no raw HTML injection).
- [ ] Citation chips: validated markers → chips labeled with conversation/sender; click opens `/chat/c/{convId}?msg={id}` in the main pane (until t175, `?msg` may only best-effort scroll — graceful if the message isn't loaded).
- [ ] Session picker in panel header: sessions listed by `updated_at`, switch/create/rename/delete; active session survives reload (persisted in prefs).
- [ ] Message-actions menu gets "Ask AI about this" → attaches ref to current session (creates one if none — grilled default) and opens the panel with the ref chip visible.
- [ ] Four-state coverage: loading (skeleton), empty (new-session hint + suggested prompts), error (typed copy for `llm-unconfigured`/429/timeout + retry), populated.
- [ ] `pnpm chat:build` clean; `/` browser build byte-unchanged.

## Test plan

### Layer 1 — Pure logic (TDD)

- [ ] citation-marker → chip parsing (malformed degrades to text)
- [ ] panel/session view-state reducers (pure list shaping, same style as `conversation-view.ts`)

### Layer 2 — Manual smoke (CDP/IPC)

- [ ] Live end-to-end: ask about a real Teams message via 9router, citation chip opens the right conversation

### Layer 3 — Visual review

- [ ] Screenshots via Chrome MCP: wide three-column + phone stacked, all four states
- [ ] Panel resize/collapse doesn't jiggle list+thread layout

## Design notes

- **Contracts changed:** none — consumes t173's contract.
- **New modules:** `chat/src/components/ai/*`, `chat/src/lib/assistant-client.ts` (session CRUD calls), citation parser lib.
- **New ADR needed?** no — ADR-0021 decision 5.

Keyboard: register panel toggle + "new session" in `chat-keys.ts` `routeKey`; ⌘K entries follow existing palette patterns. Panel must not steal the composer's `i` focus key when closed.

## Out of scope

- Scroll-to-message jump mechanics (t175 — chips just navigate).
- Quick actions (t176).
- Per-session model picker UI (env default only; t177 follow-up).

## Definition of Done

- [ ] Layers 1–3 done as above
- [ ] `pnpm check:changed` clean, `pnpm typecheck` clean, `pnpm test` green, `pnpm chat:build` succeeds
- [ ] CLAUDE.md updated (chat app section)
- [ ] Task closed: status → done, file moved to `docs/tasks/done/`, tNNN in commit
