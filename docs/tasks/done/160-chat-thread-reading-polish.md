# t160 — Thread reading polish (Messenger grouping, mentions, FAB, last-read, full-width)

Status: done
Depends on: t159
Scope: `/chat` + `core/teams-render.js`. The `/` browser build is byte-unchanged.
Plan: PSN-90 Phase 2, workstream L (items 1/3/4/6/10 + sticky separator decision #4).

## What shipped

### 1. Messenger-style timestamps (item 1 + round-2 #4)

No inline per-message timestamps. `thread-group.ts` now emits centered **time separators** on a new
calendar day ("Today 2:30 PM") or a ≥20-min idle gap ("2:30 PM" — `SEPARATOR_WINDOW_MS`); sender
grouping stays on the 5-min window. Every bubble carries the exact sent time as a hover `title`
tooltip. The current period's separator **floats** as a sticky pill while scrolling
(`flex-col-reverse` breaks CSS `position:sticky`, so it's a scroll-driven overlay reading
`data-thread-sep` off the rendered pills, fading ~1.2s after the scroll rests).

### 2. Mention-of-me highlight (item 3)

`core/teams-render.js` threads the viewer's oid through `renderBody(m, selfId)` →
`resolveMentions` — a mention whose mri oid-matches the signed-in user renders
`class="mention mention-self"` (legacy `<at id>` + itemtype spans + merged runs all covered), and
`toReaderMessages` stamps `mentionsMe` on the message. Renderer: coral-tinted pill
(`.mention-self`) + a coral-tinted bubble ring for messages that mention you. TDD'd.

### 3. Scroll-to-bottom FAB (item 4)

A floating button (bottom-right, above the composer) appears whenever the viewport is off the
bottom; click smooth-scrolls to newest. No unread count on it (not asked; YAGNI).

### 4. Last-read "New" separator (item 6, Slack semantics)

`buildThreadItems(messages, now, lastReadTs)` inserts one coral "New" hairline before the first
non-self message newer than the watermark. The watermark is captured at thread open from the
conversation prop (which still carries the pre-open `readTs` — chat-app lays its read override
after storing the row) and re-captured on each keep-alive re-show, so the marker survives while
reading and clears on the next open when nothing new arrived. Own/pending messages never re-arm it.

### 5. Full-width root (item 10)

`chat-app.tsx` drops `max-w-6xl`/`max-w-2xl` + `mx-auto` — the thread pane takes the viewport;
bubbles keep their readable `65ch` cap.

## Verification

- `vitest run chat/src core` — all pass except `core/teams-store.test.ts`, which fails only in the
  agent env (better-sqlite3 native module built for Node 24, shell has Node 20; CI is green).
- `tsc --noEmit` + biome clean.
- HITL: separators/tooltip/FAB/New-marker/full-width reviewed on the preview deploy.
