# t156 — Chat labels, folders, per-conversation mutes (Workstream K)

Status: done · web only · ADR-0019 · PSN-90 plan Workstream K

## Goal

Organise the `/chat` conversation list with **local** labels, folder grouping, and a
per-conversation notification mute. All local to our SQLite store — **never written back
to Teams**. Shared across every device that talks to this server (not device-keyed), by
design; only the folder-collapse view-state is per device.

## Store: `conversation_prefs` (core/teams-store.js)

A new table, migrated idempotently in the existing `migrate()` (CREATE … IF NOT EXISTS,
survives a re-migrate):

```
conversation_prefs (conv_id PK, labels TEXT /* JSON array */, folder TEXT, muted INTEGER)
```

CRUD:
- `getPrefs(db, convId)` → `{ labels, folder, muted }` (empty default when no row).
- `getAllPrefs(db)` → `{ convId → prefs }` map (the client holds it beside the list).
- `setPrefs(db, convId, patch)` — upsert; only the provided keys change (COALESCE against
  the current row). `labels` sanitized (trim, drop-empty, dedupe, 40-char cap) + stored as
  JSON; `folder` `""` → null (un-file); `muted` bool → 0/1. Returns the row's full prefs.

## Server (web/server.mjs, web only)

- `GET /api/teams/prefs` → `{ prefs: getAllPrefs() }` — no cred needed (keyed by convId).
- `POST /api/teams/prefs {convId, labels?, folder?, muted?}` → `{ ok, prefs: setPrefs(...) }`.

## List shaping (pure, TDD — chat/src/lib/conversation-view.ts)

- `ConvPrefs` type + `EMPTY_PREFS`.
- `applyPrefs(conv, prefs)` — merges prefs onto the server row: `muted` OR'd, `labels`/
  `folder` carried onto the conv for the UI. Same-ref on a no-op (identity-stable).
- `groupByFolder(convs)` → `FolderSection[]` — named folders alpha-sorted on top, the
  ungrouped rows as a trailing `folder: null` section. A flat list (no folders) is one
  null section, so it renders header-less exactly as before. Each section keeps the
  incoming (newest-first) order.
- `knownFolders(prefs)` / `knownLabels(prefs)` — distinct, alpha-sorted (the menu sources).
- `toggleLabel(labels, label)` — add-if-absent / remove-if-present.
- **Mute wins over unread in display:** `isUnread` now returns false for a `muted` conv, so
  the dot is off. (Wiring Teams-chat **push** fan-out to honor these mutes lands with the
  unified-push task — this task does NOT touch the `/` build's `notif-mutes` seam.)

## Client integration (chat/)

- `lib/teams-client.ts` — `ConvPrefsDto`, `fetchPrefs()`, `setPrefs()`; `labels?`/`folder?`
  added to `TeamsConversation` (set by applyPrefs, not the server payload).
- `lib/use-conv-prefs.ts` — `useConvPrefs()`: fetches the prefs map on boot, optimistic
  `patch()` (local update → POST → fold the server's authoritative row back), plus a
  per-device **folder-collapse set** persisted in ui-state (`chatFolders_<deviceId>`, the
  t154 device-pref mechanism; localStorage wipes on the iPad PWA).
- `components/conversation-list.tsx` — applies prefs over the rows HERE (same poll-proof
  point as t155's read overrides), groups into collapsible `FolderGroup` sections, and
  wraps each row in the prefs context menu.
- `components/conversation-row.tsx` — label chips after the title (small, muted); a muted
  row is dimmed (`opacity-60`) with a bell-off glyph in place of the unread dot.
- `components/conversation-row-menu.tsx` — shadcn ContextMenu (right-click / long-press):
  **Move to folder** (radio submenu of existing folders + "No folder" + "New folder…"),
  **Labels** (checkbox toggle of existing + "New label…"), **Mute/Unmute**. Inline prompts
  use the native `window.prompt` (zero-dep, local power-user feature).
- `chat-app.tsx` — `useConvPrefs` wired into both list instances; ⌘K entries when a
  conversation is focused: **Mute/Unmute conversation** and **Move to folder…** (a simple
  prompt listing existing folders).

## Poll safety

Prefs live OUTSIDE the conversation objects — a map fetched on boot + re-folded after each
write, re-applied over polled rows inside ConversationList. A 12s list poll can't clobber a
label/folder/mute (same pattern as t155 read overrides). Writes are optimistic.

## Verification

- `pnpm test` (1461) · `pnpm typecheck` · `pnpm chat:build` · `node --check web/server.mjs`
  — all clean.
- New pure tests: store CRUD (default/patch/sanitize/un-file/getAll/re-migrate) +
  `applyPrefs`/`groupByFolder`/`knownFolders`/`knownLabels`/`toggleLabel`/muted-isUnread.
- Backend CRUD live-verified via curl (POST patch → GET all round-trips).
- Live (`:7911`, real Teams host, headless CDP): seeded prefs on real conversations →
  - (a/b/c) `/tmp/psn90-k-a-folders.png` — PRIORITY + WORK folder sections with counts,
    an `urgent`/`team`/`fyi` label chip on rows, and a muted row (Glory and Haiyang)
    dimmed with a bell-off glyph + no dot.
  - collapse toggle: `/tmp/psn90-k-b-collapsed.png` — clicking WORK hides its 2 rows.
  - (d) reload: `/tmp/psn90-k-d-reload.png` — after a full page reload WORK is still
    collapsed (`chatFolders_<deviceId> = ["Work"]` in ui-state) and all labels/mutes
    survive (server-side prefs).

## Out of scope

- Teams-chat **push** fan-out honoring the mutes (lands with the unified-push task; this
  task only suppresses the in-app unread dot).
- Nested folders, label colors, label/folder rename/delete management UI, drag-to-folder.
</content>
