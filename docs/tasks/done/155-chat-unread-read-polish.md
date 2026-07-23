# t155 — Chat notifications + read/unread polish (Workstream J)

Status: done · web only · ADR-0019 · PSN-90 plan Workstream J

## Goal

Make the `/chat` conversation list tell the truth about what's unread, give explicit
mark read/unread affordances, and deep-route a Teams push tap to the conversation's
route. The store already had `read_state` (`read_horizon_ts`/`local_read_ts`); the
list UI showed none of it.

## Derivation choice (live-probed)

The raw Teams conversations payload carries **`properties.consumptionhorizon`** per
conversation, shaped `"{lastReadMsgId};{readTsMs};{clientVersion}"` (live-probed:
`"1784785126581;1784785213736;2119342568329179062"`). Its **middle field is the
epoch-ms up to which the user has read on ANY Teams client** (desktop/mobile/web).

Chosen path (cheapest + authoritative): during `upsertConversations`, parse the
middle ts (`parseConsumptionHorizonTs`) and ingest it into `read_state.read_horizon_ts`
(monotonic `MAX`). It's already in the payload the list fetch makes — **no extra
request** — and keeps unread honest when a message is read elsewhere. The local
`local_read_ts` (open/mark-read) is the second input.

**Unread = `lastMessageTs > max(read_horizon_ts, local_read_ts)` AND the last message
isn't self-sent.** Pure `isUnread` in `chat/src/lib/conversation-view.ts` (TDD).

## Read-state model + mark-unread semantics

Three write paths into `read_state`, all **local DB only — never a Teams
`consumptionhorizon` write** (Q9 hybrid; the desktop unread survives as a to-do trail):

| Action | Column write | Semantics |
|---|---|---|
| Open a thread | `setLocalRead` (monotonic MAX) | already existed in `teamsHistory`; advances `local_read_ts` to the newest message |
| Mark as read | `markConversationRead` (force `local_read_ts = ts`) | non-monotonic override so it can drop the unread sentinel |
| Mark as unread | `markConversationUnread` (`local_read_ts = -1`) | a **sticky sentinel** |

**Mark-unread sentinel (`local_read_ts = -1`).** The Teams `consumptionhorizon` keeps
being ingested into `read_horizon_ts` every poll, so a plain `local_read_ts = 0` would
be re-covered and the row would flip back to read. The `-1` sentinel makes
`listConversations` force the effective `readTs = 0` (masking the horizon), so the row
stays unread past an advancing Teams horizon until a real read overwrites it. Opening
the thread (`setLocalRead`, `MAX(-1, lastTs) = lastTs`) or mark-read clears it.

The server returns `readTs` (the effective watermark, 0 under the sentinel),
`lastMessageFromMe`, and `unreadSticky` on each list row.

## List UI

Unread rows: **semibold title + a coral `--ring` (t149) dot** + a brighter preview.
No count — that would need an extra per-conversation fetch; a bold + dot is enough
(documented, ponytail). Muted timestamps stay. Read rows unchanged.

## Instant clear + poll agreement (read overrides)

The visible rows live in **ConversationList's own state**, so optimistic patches are a
`readOverrides` map (chat-app state) passed down and applied **inside the list** via
the pure `applyReadOverride` (conversation-view.ts) — patching any other copy never
reaches the screen (live-verify bug #1). A "read" override is a readTs **floor** (a
later message still re-arms the dot; no-op once the server covers it); an "unread"
override forces the sticky shape. The override-applied list is what `onConversations`
reports upward, so the `u` toggle and ⌘K predicates agree with the screen; overrides
never expire (the max-merge makes them harmless), so a poll can't clobber them.
`patchConvRead` is **stable (deps [])** via a `conversationsRef` — when it depended on
`conversations`, every list report re-minted `openConversationById` and re-ran the
boot effect (URL still `/chat/c/{id}`), which re-laid a "read" override in a loop that
stomped a just-made mark-unread (live-verify bug #2).

Server agreement: opening a thread **persists** its read (`patchConvRead(id,"read",
true)` → POST read-local; a kept-alive pane re-open has no history load to write
local_read for it). The thread's 4s history poll sends `poll:true` and the server
skips its local-read write **only while the mark-unread sentinel is armed** — live
viewing still advances read, but "mark unread while the thread is open" survives the
poll and a refresh. `mergeConversations` compares `readTs`/`unreadSticky`/
`lastMessageFromMe` so a read-state-only change re-renders.

## Actions + keyboard

- Row: semibold + dot (no hover menu — the `u` key + ⌘K cover the action, ponytail).
- ⌘K: "Mark as read" (when unread) / "Mark as unread" (when read), Conversation group.
- Key: **`u`** toggles read/unread on the focused (list) or open (thread) conversation
  (`chat-keys.ts` → `toggle-read` intent; overlay lists it once on "Mark as read").

## Notification deep-route

`chat/public/sw.js` `notificationclick` cold tap now opens **`/chat/c/{convId}`**
(workstream I's URL scheme) instead of `?conv=`; warm tap still postMessages
`open-conv`. The unified-push pipeline itself is out of scope — this only points the
chat app's own SW at the conversation route. An unknown id degrades to the list.

## Files changed

**Backend**
- `core/teams-store.js` — `parseConsumptionHorizonTs`; `shapeConversation`/`upsertConversations`
  take `selfId`, write `last_message_from_me` (new column, idempotent `ALTER`), ingest the
  consumptionhorizon into `read_horizon_ts`; `listConversations` LEFT JOINs `read_state` →
  `readTs`/`lastMessageFromMe`/`unreadSticky` with the `-1` sentinel; `markConversationRead`/
  `markConversationUnread`.
- `web/server.mjs` — pass `cred.userId` as `selfId` to the upsert; `POST /api/teams/read-local
  {convId, action:"read"|"unread", ts}` (local-only, web only); `/api/teams/history` accepts
  `poll` → `teamsHistory` spares an armed mark-unread sentinel on background polls.

**Renderer (`chat/`)**
- `lib/teams-client.ts` — `readTs`/`lastMessageFromMe`/`unreadSticky` on `TeamsConversation`;
  `markReadLocal`; `fetchHistory` `poll` flag.
- `lib/conversation-view.ts` — pure `isUnread` + `ReadOverride`/`applyReadOverride` (TDD).
- `lib/conversation-merge.ts` — `sameConv` compares the read fields.
- `lib/chat-keys.ts` — `u` → `toggle-read`.
- `components/conversation-list.tsx` — `readOverrides` prop; override-applied `display`
  renders the rows + feeds `onConversations`.
- `components/conversation-row.tsx` — semibold + coral dot + brighter preview on unread.
- `components/thread-view.tsx` — the 4s poll passes `poll:true`.
- `chat-app.tsx` — `readOverrides` state, stable `patchConvRead` (conversationsRef),
  opens persist read, `toggleReadUnread`, `u` handler, ⌘K mark-read/unread actions.
- `public/sw.js` — cold-tap deep-route to `/chat/c/{id}`.

## Verification

- `pnpm test` (1448) · `pnpm typecheck` · `pnpm chat:build` — all clean.
- New pure tests: `isUnread`, `applyReadOverride`, `parseConsumptionHorizonTs`, ingest,
  `last_message_from_me`, mark-read/unread, sticky-survives-horizon, `u` routing.
- Live (`:7911`, real Teams host, DOM-verified via headless CDP): click a dotted row →
  dot gone <1s and still gone after a 16s poll cycle (13 other dots untouched); `u` on
  the open thread re-arms the dot, survives 16s of thread+list polls, server sentinel
  intact (`sticky:true, readTs:0`); reload shows the dot; reopen clears it durably
  (server `sticky:false`, readTs advanced).
- Screenshots: `/tmp/psn90-j-clear-fixed.png`, `/tmp/psn90-j-unread-open.png`,
  `/tmp/psn90-j-reload-reopen.png` (+ the earlier `/tmp/psn90-j-a-list-unread.png`).

## Out of scope

- Unified push pipeline / server backstop sweep (separate task); per-conversation mute
  (workstream K); unread count numerals (needs an extra fetch).
</content>
</invoke>
