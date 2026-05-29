# 028 — make notification adapter a drop-in seam with activate and groupkey

- **Status:** done
- **Mode:** HITL
- **Estimate:** 1d
- **Depends on:** 027, 025
- **Blocks:** none

## Goal

Today the Notification Adapter is shallow on the read side (hostname + capture script) but its consumers are not: the click handler hardcodes an if/else over source name and `targetEntity` shape (Outlook `deepLink` → SPA-navigate, Teams `chats` thread id → open thread, everything else → just activate the Tab), and grouping keys on `targetEntity.id ?? title ?? source`. Both encode per-app knowledge in generic code. After this task, every notification entry carries three normalized, adapter-agnostic fields — `adapter` (the matched adapter name), `groupKey` (a stable grouping id, defaulting to URL origin), and an optional `activate` tagged union (`{ type, ... }`) — emitted by the Notification Capture scripts. The renderer dispatches activation through a registry keyed by `activate.type` that maps each variant to a Remote Page intention, replacing the hardcoded branches. Grouping (the unread aggregator from 025 and `groupByConversation` in Notifications View) keys on `groupKey`. With both Teams and Outlook expressed purely through this seam, adding a third Notification Adapter (Slack) later becomes one capture script, one adapter config entry, and one activation-type handler, with zero edits to the notification center, ingest, store, or renderer dispatch.

## Why now

A Slack Notification Adapter is the next concrete adapter and it needs two things this seam provides: multi-workspace grouping (Slack notifications from different workspaces must group separately, which `targetEntity.id ?? title` cannot express) and its own activation flow (open a channel/DM). Building the seam now — while there are two real adapters to validate it against (Teams thread + calls, Outlook SPA-link) — proves it is a genuine seam and not a single-use abstraction. It also retires a fragile class of coupling: the click handler currently grows an `else if` per adapter. The notification center (027) gives a single place that stamps `entry.adapter`; the unread aggregator (025) gives a single keying point — both are prerequisites so this task only adds the field plumbing and the dispatch registry, not the surrounding lifecycle.

## Acceptance criteria

- [ ] Each notification entry produced by the center carries `adapter: string` (the matched Notification Adapter name) and `groupKey: string`.
- [ ] `groupKey` defaults to the entry's URL origin when the Notification Capture script emits none, preserving today's per-origin grouping behavior exactly.
- [ ] Notification entries may carry an optional `activate` tagged union (`{ type: string, ... }`); entries without one (e.g. a Teams `calls` toast) only activate their Tab.
- [ ] The Outlook capture script emits `activate: { type: 'spa-link', url }` (the existing message deep-link) and Teams `chats` toasts emit `activate: { type: 'thread', id }` (the existing thread id); ids are semantic only — no raw DOM selectors cross the seam.
- [ ] The renderer resolves activation through a registry keyed by `activate.type`, each handler producing a Remote Page intention; the hardcoded source/`targetEntity` if/else in the click path is removed.
- [ ] Clicking a notification with no `activate` (or an unknown `type`) activates the owning Tab and does nothing further — no throw.
- [ ] `groupByConversation` and `aggregateUnread` key on `groupKey`; with `groupKey === origin` the grouped/aggregated output is unchanged from before this task.
- [ ] `CONTEXT.md`'s **Notification Adapter** entry is sharpened to describe the `adapter` / `groupKey` / `activate` contract and the registry-based activation seam.
- [ ] Adding a hypothetical third adapter requires no edit to the notification center, ingest, store, or the renderer dispatch loop (verified by inspection / a registry-extension test, not by writing the Slack adapter).

## Test plan

Per [../conventions/tdd.md](../conventions/tdd.md). The seam-shaping is pure logic (Layer 1); the capture-script emit + end-to-end click is CDP/IPC glue (Layer 2); the popover grouping is visual (Layer 3).

### Layer 1 — Pure logic (TDD)

- [ ] activation registry — dispatch by `activate.type` returns the mapped intention for `spa-link` and `thread`; an absent `activate` or an unregistered `type` yields the activate-Tab-only outcome with no throw.
- [ ] activation registry — a newly registered `type` is dispatched without touching existing handlers (proves zero-core-edit extensibility).
- [ ] `groupByConversation` — groups on `groupKey`; given `groupKey === origin` the resulting groups and per-group `unread` match the pre-change keying for the same input.
- [ ] `aggregateUnread` (025) — keys `byGroup`/`byOrigin` on `groupKey`; with `groupKey === origin` the one-pass output is identical to the origin-keyed baseline.
- [ ] `groupKey` defaulting — a normalization helper fills `groupKey` from URL origin when the capture payload omits it, and preserves an explicit `groupKey` when present.

### Layer 2 — Manual smoke (CDP/IPC)

Steps to manually verify with a live Remote Browser (Teams + Outlook tabs open as background Tabs with their Notification Side-Channels attached):

- [ ] Trigger a Teams chat message → toast captured → entry has `adapter: 'teams'`, `groupKey` (origin), `activate: { type: 'thread', id: '19:…@thread.v2' }`. Clicking it activates the Teams Tab and opens that thread (chat row clicked, no reload).
- [ ] Trigger an Outlook mail → entry has `adapter: 'outlook'`, `activate: { type: 'spa-link', url }`. Clicking it activates the Outlook Tab and SPA-navigates to the message without a full reload.
- [ ] Trigger a Teams meeting-start (`calls`) toast → entry has `adapter: 'teams'` and no `activate`. Clicking it only activates the Teams Tab (no navigation, no throw).
- [ ] Confirm the same behavior on the web build path (notification center runs headless on the server; click routes through the same activation-type handlers).

### Layer 3 — Visual review

- [ ] Screenshots captured via Chrome MCP against `pnpm dev` of the notification popover with mixed Teams + Outlook entries.
- [ ] All four states visible: loading (no entries yet), empty (no notifications), error (Side-Channel detached), populated (grouped by `groupKey`).
- [ ] Verify conversation grouping is unchanged visually vs current `main` (same `groupKey === origin` keying), and unread badges per group are correct.

## Design notes

Behavioral contracts only. The Notification Adapter becomes a deep seam: capture scripts emit a normalized payload, the center stamps the adapter name, and consumers read three fields without per-app branching.

- **Contracts changed:**
  - Notification entry shape — gains `adapter: string`, `groupKey: string`, and optional `activate: ActivateIntent`. `ViewEntry` (Notifications View) gains `groupKey` and reads it as the grouping key (was `targetEntity.id ?? title ?? source`). The aggregator entry shape (025) reads `groupKey` for its `byGroup`/`byOrigin` pass.
  - Notification Capture payload — capture scripts now emit `groupKey?` and `activate?` alongside the existing fields; `targetEntity` stays for backward-compatible display but is no longer the activation source of truth. Only semantic ids cross the binding (thread id, message url) — never selectors.
  - The renderer click path — was a hardcoded if/else over source + `targetEntity`; becomes a lookup in an activation registry keyed by `activate.type`, with a default branch that only activates the Tab.

- **New modules:**
  - A pure activation-dispatch module (registry keyed by `activate.type` → a Remote Page intention descriptor). Justified: it is the single extension point an adapter plugs an activation into, and it must be unit-testable without a Remote Page; the registry holds no per-app `if`. Lives alongside the other pure `src/lib` domain modules and stays pure (no IPC, no DOM) — the actual intention is executed by the existing Remote Page (`navigateSpa`, `openTeamsThread`) in the effect layer.

- **New ADR needed?** no — ADR-0003 (notifications side-channel) already governs the Side-Channel + activation strategy; this sharpens the seam within it. The `CONTEXT.md` **Notification Adapter** entry is updated in this commit instead.

```ts
// the activate tagged union (semantic ids only — no selectors)
type ActivateIntent =
  | { type: 'spa-link'; url: string }      // outlook: deep-open a message via navigateSpa
  | { type: 'thread'; id: string }         // teams chats: open the conversation by thread id
// teams calls / unknown adapters emit no activate → activate the Tab only

// each entry, after the center stamps it (027)
interface NotificationEntryFields {
  adapter: string                          // matched Notification Adapter name
  groupKey: string                         // default = URL origin; e.g. future "slack:{teamId}"
  activate?: ActivateIntent
}

// pure dispatch — type -> a Remote Page intention descriptor; default = activate Tab only
type ActivationHandler = (a: ActivateIntent, targetId: string) => RemotePageIntention | null
// registry: Record<ActivateIntent['type'], ActivationHandler>; adding Slack = one entry
```

## Out of scope

- The Slack Notification Capture script and the Slack adapter config entry — a future Slack task adds the capture script + one adapter entry + one activation-type handler against this seam.
- Multi-workspace tab↔notification matching (mapping a Slack notification to the right workspace Tab/Pin) — future Slack task.
- Changing the notification center / ingest / store lifecycle (027) or the unread aggregator's single-pass structure (025) — this task only adds field plumbing and the dispatch registry on top of them.
- Any change to `__cdpNotify` binding transport or the Side-Channel attach/reconcile lifecycle.

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
- [ ] Task closed: status → done, file moved to `docs/tasks/done/`, tNNN in commit

## Notes

- `groupKey` is intentionally forward-compatible: keying everything on `groupKey` now (with origin as the default) means the Slack adapter only has to start emitting `slack:{teamId}` and grouping just works — no consumer change.
- Keep the `activate` union closed and small; an unknown `type` must degrade to activate-Tab-only, never throw, so an older renderer tolerates a newer capture script.
- Verify both backends: the web server runs the notification center headless, so the activation registry must live on the renderer side of both Electron and web paths and read the same `activate` field.

---

_When task status flips to `done`, move this file to `done/`._
