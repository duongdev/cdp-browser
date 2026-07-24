# t168 — Conversation row v2 (avatar dot, custom titles, mention counter, filters, live times)

Status: done
Depends on: t167
Scope: `/chat` + `core/teams-store.js` + `web/server.mjs`. The `/` browser build is byte-unchanged.
Plan: PSN-95 workstream E. Grilled: #1 (numeric counter, local floor), #5 (avatar
top-right dot), #6 (server-shared rename via menu + ⌘K), #7 (filters keep folder
grouping, empty folders hidden).

## What shipped

- **Avatar-anchored unread dot**: the coral dot now rides the avatar box's
  top-right corner (`ring-2 ring-background` bite) — one fixed position for
  single + facepile, so unread state never shifts row layout. The right column
  keeps timestamp + mute bell + the new mention badge.
- **Custom titles** (`conversation_prefs.custom_title`, `ADD_COLUMNS`): local
  rename, shared across devices, never written to Teams. Row + thread header show
  the custom title with the original beside it (smaller, muted). Edit via row
  context menu "Rename chat…" + ⌘K (blank clears). Palette jump rows label
  "Custom (Original)" so the fuzzy filter matches both names.
- **Mention counter**: `messages.mentions_me` persisted at upsert (from
  `toReaderMessages`' `mentionsMe`); `listConversations` counts unread @me
  messages per row (`ts > readTs AND mentions_me AND NOT deleted`) →
  `mentionCount`. **Unified with the unread indicator (t170 follow-up):** the
  avatar-corner badge is a plain dot for unread and grows into a numbered coral
  pill when there are unread @mentions — one indicator, not a separate
  right-column `@N`. A local floor by design (only synced pages count);
  `mergeConversations` diffs it so a poll re-renders the badge.
- **Filters**: segmented All / Unread / Mentions pill bar above the list (pure
  `filterConversations`, runs before `groupByFolder` so empty folders drop).
  The reported list is the filtered list, so keyboard j/k and ⌘K agree with the
  screen for free. Filtered-empty keeps the bar visible ("Nothing unread").
- **Live "ago" times**: one list-level 30s tick (paused while hidden) feeds a
  `now` prop through every row's `relativeTime` — no per-row timers, no stale
  "5m".

## Verification

- `vitest run chat/src core` — 825 pass on Node 22; `core/teams-store.test.ts`
  (native better-sqlite3) passes 36/36 on Node 24 (updated for the new pref
  fields + a t167/t168 round-trip case; the Node-22 native-module failure is the
  known agent-env issue, CI green).
- `tsc --noEmit` clean; biome exit 0; `node --check` server+store;
  `pnpm build` + `pnpm chat:build` succeed.

## Known ceilings / carry-overs

- Mention count only sees locally-synced pages — a mention in a never-opened
  conversation isn't counted until its page syncs (the t147 sweep only reads the
  list's lastMessage). Numeric-with-floor accepted in grill #1.
- Filter selection is view-state (resets on reload); persistence not asked.
