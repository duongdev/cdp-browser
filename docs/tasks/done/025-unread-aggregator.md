# 025 — add pure unread aggregator over notifications tabs and pins

- **Status:** done
- **Mode:** HITL
- **Estimate:** 0.5d
- **Depends on:** none
- **Blocks:** 028

## Goal

Today the renderer computes unread badge counts in three chained `useMemo`s — `unreadByOrigin`, then `unreadByTab`, then `unreadByPin` — each re-walking the data and only implicitly covered by UI behavior. This task replaces those with one pure `aggregateUnread(notifications, tabs, pins, linkedTabByPin)` function in a new `src/lib/unread-aggregator.ts` module that returns `{ byTab, byPin }` plus the underlying group map in a single pass over the notifications. Each notification is keyed on `groupKey ?? origin` (the URL origin of its `targetUrl`), so the by-origin grouping behavior — every Tab and Pin of the same app (all Teams, all Outlook) sharing one count, and a dormant Pin badging by its saved URL's origin — is preserved exactly, while the keying becomes forward-compatible for task 028's `groupKey`. After this ships, `app.tsx` holds no unread-counting logic of its own: it calls the pure aggregator and applies the result to the sidebar and bell badges.

## Why now

Unread accounting is correct but redundantly cached and only verified through the rendered UI, so the all-Teams-tabs-share-one-badge contract has no direct test. Pulling it into a pure deep module gives locality (one place owns the rule) and a table-driven test that pins the grouping behavior down. It also establishes the `groupKey ?? origin` keying that task 028 builds on when it introduces a real `groupKey` on notification entries — once the aggregator already keys on it, 028 is a data change, not a logic rewrite.

## Acceptance criteria

- [ ] `src/lib/unread-aggregator.ts` exports a pure `aggregateUnread(notifications, tabs, pins, linkedTabByPin)` that returns `{ byGroup, byTab, byPin }`.
- [ ] A notification is keyed on `groupKey ?? originOf(targetUrl)`; when `groupKey` is absent the key is the URL origin (identical to today's behavior).
- [ ] Unread is counted in a single pass over `notifications`; read notifications and notifications with no resolvable key are excluded.
- [ ] `byTab[tab.id]` resolves through the Tab's own `url` origin; an unkeyable Tab gets `0`.
- [ ] `byPin[pin.id]` resolves through the linked Tab's live `url` when linked (via `linkedTabByPin`), otherwise the Pin's saved `url`; an unkeyable Pin gets `0`.
- [ ] `app.tsx` no longer contains the `unreadByOrigin` / `unreadByTab` / `unreadByPin` `useMemo`s; it calls `aggregateUnread` and passes `byTab` / `byPin` to the sidebar unchanged.
- [ ] The function is DOM-free and side-effect-free (no React, no `window`).
- [ ] Sidebar per-Tab/per-Pin badges and the NotificationBell count render identically to before for the same notification/tab/pin state.

## Test plan

### Layer 1 — Pure logic (TDD)

- [ ] `unread-aggregator.aggregateUnread` — by-origin grouping: two Tabs on the same origin both report the count of unread notifications for that origin (the all-Teams-tabs-share-one-badge case).
- [ ] `unread-aggregator.aggregateUnread` — `read: true` notifications are excluded from every count.
- [ ] `unread-aggregator.aggregateUnread` — linked Pin resolves its count through the live linked Tab's `url` origin (via `linkedTabByPin`), not the saved URL, when the linked Tab has drifted to a different origin.
- [ ] `unread-aggregator.aggregateUnread` — dormant (unlinked) Pin resolves its count through its saved `url` origin.
- [ ] `unread-aggregator.aggregateUnread` — a notification, Tab, or Pin whose URL yields no origin contributes/receives `0` rather than throwing.
- [ ] `unread-aggregator.aggregateUnread` — when a notification carries `groupKey`, it is keyed on `groupKey` and a Tab/Pin only matches if its resolved key equals that `groupKey` (forward-compat probe; default path uses origin).

### Layer 2 — Manual smoke (CDP/IPC)

Steps to manually verify with a live Remote Browser:

- [ ] Connect with a Teams Tab and an Outlook Tab open; trigger an in-app toast on each via the Notification Side-Channel and confirm each app's Tab badge increments while the other's stays put.
- [ ] Open a second Teams Tab and confirm both Teams Tabs show the same unread count from one notification.
- [ ] Pin a Teams Tab, then close its linked Tab, and confirm the dormant Pin still badges by its saved URL's origin when a new Teams notification arrives.
- [ ] Mark a notification read from the bell and confirm the corresponding Tab/Pin badge decrements.

### Layer 3 — Visual review

- [ ] Screenshots captured via Chrome MCP against `pnpm dev`
- [ ] All four states visible: loading, empty (no unread), error, populated (multiple unread across origins)
- [ ] Sidebar Tab/Pin unread badges and the NotificationBell count are pixel-identical to the pre-change build for the same fixture state.

## Design notes

The aggregator is a deep module: a small interface (one function) hiding the whole unread-counting rule. It absorbs the three chained memos into one pass and centralises the `groupKey ?? origin` keying so the grouping seam lives in one place. `app.tsx` keeps owning the React effects (it still builds `linkedTabByPin`, still wires the result into the sidebar) — only the counting moves out, matching the lib pure-module invariant. The function takes the origin resolver behavior as part of its own contract (it derives keys internally from the passed-in URLs); callers pass plain data, never DOM nodes.

- **Contracts changed:** unread counting in `app.tsx` — three chained `useMemo`s (`unreadByOrigin` → `unreadByTab` → `unreadByPin`) → one call to `aggregateUnread` returning `{ byGroup, byTab, byPin }`. The sidebar props `unreadByTab` / `unreadByPin` are unchanged in shape.
- **New modules:** `src/lib/unread-aggregator.ts` — one pure deep module owning the unread-by-group rule and the `groupKey ?? origin` keying, with a table-driven test; justification is locality + a direct test for the share-one-badge contract that today only exists implicitly in the UI.
- **New ADR needed?** no — this is a pure-logic consolidation under the existing lib invariant; no new architectural decision.

```ts
type NotificationEntry = {
  id: string
  read: boolean
  targetUrl?: string
  groupKey?: string // absent today; introduced by task 028. Falls back to origin.
}

type UnreadResult = {
  byGroup: Record<string, number> // key = groupKey ?? origin
  byTab: Record<string, number> // tab.id -> count
  byPin: Record<string, number> // pin.id -> count
}

// Pure: no React, no window, no DOM. linkedTabByPin maps pin.id -> live linked Tab.
declare function aggregateUnread(
  notifications: NotificationEntry[],
  tabs: TabInfo[],
  pins: Pin[],
  linkedTabByPin: Record<string, TabInfo>,
): UnreadResult
```

## Out of scope

- Introducing the actual `groupKey` field on notification entries or any capture-script changes (that is task 028 / the Notification Adapter seam). This task only makes the aggregator key on `groupKey ?? origin` so it is ready.
- Changing how the Notification Side-Channel captures or persists notifications, or any main-process / `server.mjs` notification logic.
- Changing badge presentation, the NotificationBell popover grouping (`notifications-view.ts`), or sidebar layout.
- Multi-workspace tab↔notification matching (future Slack task).

## Definition of Done

All must be true before status → done.

- [ ] Layer 1 tests written and green (if pure logic was touched)
- [ ] Layer 2 smoke checklist completed with a live Remote Browser (if main.js/IPC touched)
- [ ] Layer 3 screenshots captured and committed (if UI touched)
- [ ] `pnpm check` clean (Biome — lint + format)
- [ ] `pnpm typecheck` clean
- [ ] `pnpm test` green
- [ ] `pnpm dev` boots cleanly and the changed surface works end-to-end
- [ ] CLAUDE.md updated for any modified module
- [ ] ADR written if an architectural decision was made
- [ ] No commented-out code, no `console.log` debris, no AI attribution
- [ ] Task closed: status → done, file moved to `docs/tasks/done/`, t025 in commit

## Notes

Current `app.tsx` keying uses `originOf(url)` for the group key; the aggregator should keep that exact origin derivation as its fallback so behavior is byte-identical when `groupKey` is absent. The pre-existing `linkedTabByPin` memo stays in `app.tsx` and is fed into the aggregator — the linked-Pin-via-live-tab-URL and dormant-Pin-via-saved-URL split is the same logic the old `unreadByPin` memo encoded. Keep `byGroup` in the return so 028 and `notifications-view` grouping can reuse the same single-pass tally instead of recomputing.

---

_When task status flips to `done`, move this file to `done/`._
