# t159 — Chat composer redesign, optimistic non-blocking send, rich editor

Status: done
Depends on: t158
Scope: `/chat` (Teams chat app) + `web/server.mjs` reply endpoint. The `/` browser build is
byte-unchanged. Plan: PSN-90 Phase 2, workstream M (items 5/7/8).

## What shipped

### 1. Optimistic non-blocking send (item 7)

The composer never blocks: a send appends a **pending bubble** immediately (local placeholder id
`local:{seq}:{now}`), clears + refocuses the editor, and the POST runs behind it. Media (image +
file) rides the same path. Failure marks the bubble (`failed: code`) with honest copy plus
**Retry / Discard** inline — the input is never frozen and a queued next message can be typed while
the first is in flight.

- `message-merge.ts`: `resolveLocalSend` (swap local id → server id/ts; drops the placeholder if a
  poll already delivered the echo) + `markSendFailed`. TDD'd.
- `thread-view.tsx`: `runSend`/`onComposerSend`/`onRetrySend`/`onDiscardSend`; retry payloads in a
  ref keyed by local id. The old `reduceSend` phase machine retired (`teams-reply.ts` keeps only
  `selectReplyTarget`).
- `message-row.tsx`: pending → muted bubble + "Sending…"; failed → ring + copy + retry/discard;
  react/edit/delete suppressed until confirmed.

### 2. Rich editor + redesigned composer (item 5)

`components/composer.tsx` — a contenteditable in a raised card (rounded-2xl, hairline border,
soft shadow, focus-within ring) with a bottom action row: attach, B/I/U/S + bulleted/numbered list
(document.execCommand — lazy, universal), and a primary send button. Enter sends, Shift+Enter
breaks, paste is plain-text-forced (image paste stages an attachment). ⌘B/⌘I/⌘U work natively in
contenteditable.

- `rich-compose.ts` (pure, TDD): `cleanEditorHtml` (outgoing tag allowlist, href-only `<a>`),
  `outgoingFromEditor` (plain multi-line stays a Text send; real formatting → HTML payload),
  `textToHtml` (escaped optimistic body).
- Wire: `POST /api/teams/reply` accepts optional `html` (typed + 64k-capped) →
  `sendTeamsMessageInPage(..., "RichText/Html")`; plain sends keep the Text messagetype.
- Note: the ui-ux-pro-max plugin skill file was permission-blocked in the agent env; the design
  pass used the t149 Airbnb token layer directly.

### 3. Loading state shows a live composer (item 8)

The composer renders for every thread state (loading/error/ready) and auto-focuses whenever the
pane is visible on a fine-pointer layout — you can start typing before history lands. Coarse
pointer never auto-focuses (keyboard pop).

## Verification

- `vitest run chat/src/lib` — 179 pass (new rich-compose + resolveLocalSend/markSendFailed suites).
- `tsc --noEmit` clean; `node --check web/server.mjs` clean; biome clean on touched files.
- HITL: live send/format/fail-retry pass on the preview deploy (per tdd.md, UI glue is manual).
