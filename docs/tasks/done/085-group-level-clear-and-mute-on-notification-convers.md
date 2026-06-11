# 085 — group-level clear and mute on notification conversations

- **Status:** done
- **Mode:** HITL
- **Estimate:** 0.5d
- **Depends on:** 076, 082
- **Blocks:** none

## Goal

One tap to act on a whole conversation instead of per message: each group header (Inbox + bell popover) gets Mark-read, Mute-channel (where the channel id is known), and Clear (remove all of the conversation's entries, including collapsed ones). "Clear" is a real removal backed by a new store `removeMany(ids)`.

## Acceptance criteria

- [x] Group header shows mark-read (when unread), mute (when an exclude target exists), and clear.
- [x] Clear removes every entry sharing the group's threadKey — collapsed ones too — and persists.
- [x] Mark-read / mute reuse the existing thread-read + channel-exclude handlers.
- [x] Bell popover actions reveal on hover / always on touch.

## Test plan

### Layer 1 — Pure/store (TDD)
- [x] `removeMany(ids)` drops only listed ids + persists; no-op on no match (2 tests).

### Layer 2 — e2e
- [x] `POST /api/notifications/remove` returns 200 + remaining list (hermetic e2e).

### Layer 3 — Visual
- [x] Harness: group headers show the 3 actions; clearing a conversation removes it.

## Design notes

- **Contracts changed:** notification center gains `removeMany(ids)`; new `POST /api/notifications/remove`, `window.cdp.removeNotifications(ids)` (web + Electron IPC).
- **New ADR needed?** no.

## Notes

Clear computes the id set in the renderer (all entries with the same `threadKey`) and posts it, mirroring the existing `markThreadRead` pattern. Mute only targets sweep entries with a channel id (unchanged from t072); legacy hijack stubs can be cleared/read but not channel-muted.

---

_When task status flips to `done`, move this file to `done/`._
