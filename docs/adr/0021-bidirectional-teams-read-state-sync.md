# ADR-0021: Bidirectional Teams read-state sync

- **Status:** Accepted
- **Date:** 2026-07-27

## Context

t155 shipped read/unread in the chat app as **local state only** (decision Q9): the app tracked what
you had read, but never told Teams. The reasoning was that the desktop Teams unread badge then
survived as a to-do trail after triaging in the chat app.

In practice it made the two clients disagree permanently. Reading a chat in the chat app left it bold
in Teams; reading it in Teams left it bold in the chat app for anything the local watermark hadn't
covered; and "mark as unread" existed twice with no relationship between the two.

Teams stores read state in two per-conversation properties, and the split is forced by the API, not a
style choice (both verified live against a real tenant):

| Property | Meaning | Writable |
|---|---|---|
| `consumptionhorizon` | read watermark, `{msgId};{ts};0` | **Forward only.** A rewind PUT returns `200` and is silently clamped. |
| `consumptionHorizonBookmark` | native "Mark as unread", `0;{ts};0` (`0;0;0` clears) | Freely writable, no clamping. |

So "unread again" is *impossible* to express with the watermark alone. Any design that models read
state as a single number cannot round-trip mark-unread.

## Decision

Read state is **shared with Teams, both directions**. Teams is the source of truth; the local store is
a mirror plus an optimistic overlay.

- **Ingest both properties.** `core/teams-store.js` parses the bookmark with the same helper as the
  horizon and passes it through the `/internal/teams/*` seam as `ChatConversation.unreadBookmarkTs`.
  The BFF persists it in `read_state.unread_bookmark_ts` and derives, in one place
  (`effectiveReadTs`): `readTs = bookmarkTs > 0 ? bookmarkTs - 1 : max(horizon, localRead)`, with
  `unreadSticky = bookmarkTs > 0`. The old `local_read_ts = -1` sentinel is deleted — the service's
  own bookmark replaces it.
- **Write through, provider first.** `POST /api/chat/mark-read` advances the horizon **and** clears
  the bookmark; `POST /api/chat/mark-unread` sets it. Both call Teams before touching the local row,
  so a failure is a typed error the client reverts on rather than a silent divergence. The local-only
  `/api/chat/read-local` route is gone.
- **Auto-read is gated.** Opening a conversation marks read only when the pane is visible and the
  window focused. An explicit mark-unread arms a per-conversation latch so auto-read cannot
  immediately undo it until the user leaves and returns.
- **Fetching history never marks read.** Its old local-read write re-read a just-marked-unread
  conversation on the next 4s poll.
- **Teams → app rides the existing 12s list sweep.** No new polling lane.

Two constraints are load-bearing and easy to regress:

1. **Mark-read must clear the bookmark.** The horizon alone cannot un-flag a conversation, so a stale
   bookmark keeps a row unread forever.
2. **The horizon's msgId must be a bare integer.** Teams' own `lastUpdatedMessageId` sometimes carries
   a `.0` suffix and Teams `400`s on it, so it is normalized where the string is built.

## Consequences

- One read state across every Teams client. Reading or marking unread anywhere shows up everywhere
  within ~12s, and mark-unread finally survives a refresh because it lives on the service.
- The "desktop unread as a to-do trail" workflow is gone by design. Mark-unread is now first-class in
  both clients, which covers the same need explicitly instead of as a side effect.
- Read state now depends on an **undocumented** Teams property. It is the same properties endpoint the
  shipped mark-read already used, and a failure surfaces as a typed provider error rather than a
  crash — but a Microsoft change could break mark-unread specifically.
- The watermark is **unrecoverably monotonic**: writing a horizon too far ahead cannot be undone. Only
  a real rendered message's ts may be written — never `Date.now()`.

## Alternatives

- **Rewind `consumptionhorizon` for mark-unread.** Impossible: verified live that Teams accepts the
  request and silently clamps it. This is why a second property exists at all.
- **Keep read state local (status quo, t155 Q9).** Rejected: it is what this ADR exists to fix. The
  to-do-trail benefit did not outweigh two clients that permanently disagree.
- **Local state wins, Teams best-effort.** Rejected: tolerant of a failed write, but the two can drift
  forever and "read it in Teams" would not clear the chat app — most of the original problem intact.
- **A faster sync lane (4s, or refresh on focus).** Rejected for now: 3× the API calls for a state
  change the user rarely watches happen. 12s is imperceptible in practice.
- **Sync mute / favorite in the same pass.** Deferred: separate concepts, separate properties
  (`alerts`, `favorite`), separate issues.
