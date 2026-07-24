# t167 — Mute v2 (unread survives, timed mute, notify-on-mention)

Status: done
Scope: `/chat` + `core/teams-store.js` + `core/teams-notify-sweep.js` + `web/server.mjs`.
The `/` browser build is byte-unchanged.
Plan: PSN-95 workstream D. Grilled: #1 (unread survives), #2 (1h/8h/24h/forever),
#3 (per-conversation opt-in), #4 (keep dim, bell + dot coexist).

## What shipped

- **Schema** (`conversation_prefs`, idempotent `ADD_COLUMNS`): `muted_until`
  (epoch ms; NULL = forever) + `notify_on_mention` (0/1). `getPrefs`/`getAllPrefs`/
  `setPrefs` round-trip them; a `muted` write without an expiry clears any stale
  window. New pure `isMutedNow(prefs, now)` — expired window reads unmuted, no
  cleanup write needed (the predicate is the truth). Mirrored in
  `conversation-view.ts`.
- **Unread survives mute**: `isUnread` no longer returns false for a muted row;
  the row keeps the `opacity-60` dim and shows bell-off AND the coral dot
  side-by-side. `applyPrefs` now lays the *effective* muted-now verdict on the row
  (so an expired timed mute un-dims without any poll/write).
- **Push gate** (`web/server.mjs` sweep): before sending, each notification checks
  its conversation's prefs — muted-now skips the push **unless** `notifyOnMention`
  is set and the message `mentionsMe`. `mentionsMe` is stamped by the pure planner
  (`core/teams-notify-sweep.js` `mentionsSelf` — normalized self-oid substring in
  the content; oids appear in chat content only inside mention tags).
- **UI**: row context menu — "Mute ▸ For 1 hour / 8 hours / 24 hours / Until I
  unmute", "Unmute" when muted-now, and a "Notify on mention" checkbox
  (per-conversation, opt-in). ⌘K "Mute/Unmute conversation" quick-toggles
  forever-mute and reads the muted-now verdict.

## Verification

- `vitest run core/teams-notify-sweep.test.ts chat/src/lib/conversation-view.test.ts`
  — 49 pass (new: mentionsMe stamp, mentionsSelf matrix, isMutedNow matrix,
  expired-mute applyPrefs, unread-survives-mute).
- `tsc --noEmit` clean; biome exit 0; `node --check` on server + core;
  `pnpm chat:build` succeeds.

## Known ceilings / carry-overs

- `mentionsSelf` is a substring heuristic (ponytail note in source) — upgrade to a
  mention-span parse only if a false positive shows up.
- The dot moves from the right column onto the avatar in workstream E (t168);
  this task only stops mute from hiding it.
- An expired timed mute leaves `muted=1` + past `muted_until` in the DB (read as
  unmuted everywhere); no vacuum job, by design.
