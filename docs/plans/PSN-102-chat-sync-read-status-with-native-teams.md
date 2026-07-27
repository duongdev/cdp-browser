# PSN-102 — Sync read status with native Teams

Make read/unread state in CDP Chats and native Microsoft Teams one shared state, both directions.

## Goal

- Read a chat in CDP Chats → it is read in native Teams (desktop, mobile, web).
- Read a chat in native Teams → it is read in CDP Chats.
- "Mark as unread" behaves the same in both directions.

Today read state is **local-only by design** (t155, decision Q9: "desktop unread survives as a to-do trail"). This issue reverses that decision.

## Live baseline (probed 2026-07-27 against `100.85.206.8:9222`, self-chat `48:notes`)

Teams stores per-conversation read state in **two** properties on `GET {chatServiceBase}/v1/users/ME/conversations/{id}`:

| Property | Format | Meaning | Writable? |
|---|---|---|---|
| `consumptionhorizon` | `{msgId};{ts};0` | Read watermark | **Write-only-forward.** A rewind PUT returns `200` and is *silently clamped* — verified. So mark-unread can never be a horizon rewind. |
| `consumptionHorizonBookmark` | `0;{ts};0` | Native "Mark as unread" | **Freely writable.** PUT `0;{ts};0` sticks; PUT `0;0;0` clears. Verified round-trip. |

Both write via `PUT …/conversations/{id}/properties?name={prop}`, in-page over the side-channel (same shape as the existing `markTeamsReadInPage`).

Observed in the wild: a real conversation carried `consumptionHorizonBookmark=0;1780152362792;0` while its `consumptionhorizon` was far newer — i.e. exactly "read, then marked unread".

### Code baseline

| Leg | State |
|---|---|
| Teams → app, **read** | ✅ Works. `core/teams-store.js:131` `parseConsumptionHorizonTs` → `read_horizon_ts`, ingested by the 12s list sweep (`apps/chat-server/src/sweep.ts:26`). |
| Teams → app, **unread** | ❌ Missing. `consumptionHorizonBookmark` is never parsed anywhere. |
| App → Teams, **read** | ⚠️ Plumbing exists end to end (`POST /api/chat/mark-read` → `provider.markRead` → `web/server.mjs:1791 markTeamsReadInPage`) but has **no UI caller**. |
| App → Teams, **unread** | ❌ Missing. Local sticky sentinel `local_read_ts = -1` (`store.ts:595`) never leaves the BFF DB. |

## Decisions (grilled 2026-07-27)

1. **Read write-through fires on open, gated to visible + focused.** Opening a thread PUTs `consumptionhorizon` to the newest message — but only when the pane is actually visible and the window focused. A background poll or a hidden keep-alive pane never marks read.
2. **Teams is the source of truth; the local store is a mirror.** Every local read/unread action writes to Teams first-class, then the 12s sweep reconciles. The `-1` sticky sentinel is **removed** — unread comes from the ingested `consumptionHorizonBookmark`.
3. **Mark-unread wins while the thread is open.** Marking unread arms a per-conversation latch; no auto read-through fires for that conversation until you navigate away and return. (Replaces the old sentinel's job.)
4. **Scope is read/unread only.** The probe also exposed `alerts` (mute), `favorite`/`lastTimeFavorited` (pinned chats), `isfollowed`. All **out of scope** — separate issues. No unread *count* either; the dot stays.
5. **Live verification may touch non-self chats for read state, and must revert.** Each live check records the prior `consumptionhorizon` + `consumptionHorizonBookmark` and restores them afterward. Destructive actions (send/edit/delete) stay self-chat-only.
6. **12s propagation latency is accepted.** Read state rides the existing list sweep. No new polling lane, no focus-triggered refresh.

## Derived model

Effective read watermark for a conversation:

```
readTs   = bookmarkTs > 0 ? bookmarkTs - 1 : horizonTs
unread   = lastMessageTs > readTs && !lastMessageFromMe
```

`bookmarkTs > 0` is the whole unread-sticky concept — no local sentinel needed. `markRead` must **also clear the bookmark** (`0;0;0`), otherwise a stale bookmark keeps the row unread forever.

## Workstreams

### A — Ingest the unread bookmark (Teams → app)

- `core/teams-store.js`: parse `properties.consumptionHorizonBookmark` (reuse the `;`-split shape of `parseConsumptionHorizonTs`, extract as one shared helper) → new `unread_bookmark_ts`.
- `/internal/teams/conversations` payload carries it; `providers/teams-provider.ts` maps it onto `ChatConversation`.
- `contract.ts`: add `unreadBookmarkTs: number` to `ChatConversation`; keep `readTs`/`unreadSticky` as the derived fields the FE already consumes (their *derivation* changes, their shape does not).
- `apps/chat-server/src/store.ts`: `read_state` gains `unread_bookmark_ts`; `setReadHorizon` gains a sibling `setUnreadBookmark` (**not** monotonic — it must be able to go back to 0). `listConversations` computes `readTs`/`unreadSticky` from the formula above.
- Drop the `-1` sentinel: `markConversationUnread` no longer writes `local_read_ts = -1`, and `web/server.mjs:1445`'s sentinel-sparing branch in `teamsHistory` goes away.
- Pure derivation is TDD'd (`store.ts` read-model + `conversation-view.ts`).

**Verify:** mark a chat unread in native Teams → it goes unread in CDP Chats within ~12s. Mark it read in Teams → it clears.

### B — Write both legs (app → Teams)

- `web/server.mjs`: `markTeamsReadInPage` also PUTs `consumptionHorizonBookmark: "0;0;0"` after the horizon (a read must clear any prior bookmark). Add `markTeamsUnreadInPage(convId, ts)` PUTting `0;{ts};0`, plus the `/internal/teams/mark-unread` route.
- `providers/provider.ts`: `ChatProvider` gains `markUnread(convId, ts)`. Implement in `teams-provider.ts` + `mock-provider.ts` + `stub-provider.ts`.
- `routes.ts`: `POST /api/chat/mark-unread`. `POST /api/chat/read-local` is retired — its three actions collapse into `mark-read` / `mark-unread` (both write-through). Remove the dead local-only path rather than leaving two ways to do it.
- Write failure is **honest**: the route surfaces the provider error; the FE reverts its optimistic state and toasts. No silent best-effort.

**Verify:** mark read/unread in CDP Chats → the property flips on the live Teams API and the native Teams UI reflects it.

### C — FE wiring

- `chat/src/lib/chat-client.ts`: `markReadLocal` → `markRead` / `markUnread`.
- `chat-app.tsx`: on-open read-through gated on visible + focused (reuse the existing `document.hidden` / active-pane signals the poll already uses); per-conversation **unread latch** so decision 3 holds; keep the optimistic `readOverrides` map but reconcile it against the sweep the way `applyPendingReactions` (t143) does — overlay survives until the server reflects the desired state, ~20s TTL guards a failed write.
- `u` key (`chat-keys.ts`) + ⌘K "Mark as read"/"Mark as unread" keep their current surfaces; only their target endpoint changes.
- `conversation-view.ts`: `isUnread` / `applyReadOverride` follow the new derivation; no `-1` sentinel.

**Verify:** open a thread → row de-bolds and Teams clears; press `u` → row re-bolds, Teams shows unread, and it does **not** flip back while still open; navigate away and back → it marks read again.

### D — Bug sweep + docs

- Full gate: `pnpm test`, `pnpm test:e2e`, `pnpm typecheck`, `pnpm check:changed`.
- Live end-to-end both directions on a non-self chat, **with state restored** after.
- Update `CLAUDE.md` (the t155 read-state paragraph now describes bidirectional sync) and append an ADR amendment noting decision Q9 is reversed.

### Dependencies

| Workstream | Depends on | Parallel with |
|---|---|---|
| A — ingest bookmark | — | B (different files, one shared contract field — land A first) |
| B — write legs | A's contract field | — |
| C — FE wiring | A + B | — |
| D — sweep + docs | A + B + C | — |

## Acceptance criteria

- [ ] Opening a visible + focused thread in CDP Chats marks the chat read in native Teams.
- [ ] Opening a thread in a hidden/backgrounded window does **not** mark it read.
- [ ] Reading a chat in native Teams clears its unread state in CDP Chats within ~12s.
- [ ] "Mark as unread" in CDP Chats makes the chat unread in native Teams.
- [ ] "Mark as unread" in native Teams makes the chat unread in CDP Chats within ~12s.
- [ ] Marking unread on an open thread stays unread until the user leaves and returns.
- [ ] Marking read clears any prior `consumptionHorizonBookmark` (no stuck-unread rows).
- [ ] The `-1` sentinel is gone from the schema, the store, and the FE.
- [ ] A failed Teams write reverts the optimistic UI and surfaces an error (no silent divergence).
- [ ] `pnpm test`, `test:e2e`, `typecheck`, `check:changed` all pass.
- [ ] Live verification evidence for both directions; any non-self chat touched is restored.

## Risks

| Risk | Mitigation |
|---|---|
| `consumptionhorizon` is server-monotonic — a bug that advances it too far is **unrecoverable** (cannot rewind). | Only ever write the newest *rendered* message's ts; never `Date.now()`. The bookmark is the only reversible lever. |
| Losing the "desktop unread as a to-do trail" workflow (the explicit t155 intent). | Decision 1 gates write-through to visible+focused, so a background glance never burns the trail. Mark-unread is now first-class in both clients. |
| Auto-read-on-open fights the sweep: sweep ingests, FE overlays, they oscillate. | Single derivation (`readTs` formula) + the t143 pending-overlay pattern, both pure and unit-tested. |
| Live testing pollutes real conversations. | Decision 5: capture-and-restore both properties around every non-self check; destructive ops self-chat only. |
| `consumptionHorizonBookmark` is undocumented — Microsoft may change or reject it. | It is the same properties endpoint the shipped `markRead` already uses; a failure is a typed provider error surfaced to the FE, not a crash. Verified live before planning. |

## Out of scope

- Mute (`alerts`), favorite/pinned (`favorite`), follow (`isfollowed`) sync.
- Unread **counts** — the row keeps a dot.
- Slack read-state sync (different service, different mechanism).
- Trouter/real-time read-state push — the 12s sweep is accepted (decision 6).
- Electron CDP-Browser-side read state; this is the chat app only.
