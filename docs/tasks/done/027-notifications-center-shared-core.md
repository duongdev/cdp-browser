# 027 — extract shared notification center and adopt in both backends

- **Status:** done
- **Mode:** HITL
- **Estimate:** 1d
- **Depends on:** none
- **Blocks:** 028

## Goal

Extract a backend-agnostic repo-root CJS core, `notifications-sidechain.js` (`createNotificationCenter`), that owns the whole Notification Side-Channel lifecycle and the notification store in one tested module. The center holds the `ADAPTERS` config + `adapterFor`, drives the per-target WS attach/reconcile/ingest loop against a list of Tab targets, runs the dedup/cap/`shouldNotifyOs` gating logic, and owns the store (`list`/`markRead`/`markUnread`/`markAllRead`/`clear`/`unreadCount` + persist). It receives every effect through dependency injection (`readInject`, `listTargets`, `load`, `save`, `now`, `WebSocketCtor`, `onEntry`) and stays generic — zero per-app knowledge, no Electron, no HTTP. Each ingested toast becomes a normalized entry stamped with `entry.adapter` (the matched Notification Adapter name) and fired through `onEntry(entry)` for platform effects. Both `main.js` and `web/server.mjs` adopt it: main injects Electron effects (`chromeSend` + OS `Notification` + dock badge + `shouldNotifyOs` gating), web injects in-band broadcast + `sendPushToAll`. The web server runs the center **headless** on the server lifecycle, so capture works with no client connected. After this ships, the side-channel state machine + store exist once, drift is impossible, and the lifecycle is unit-testable with fake WS + fake persist.

## Why now

The entire Notification Side-Channel state machine (adapter match, per-target socket attach/reconcile, document-start capture-script inject, `__cdpNotify` ingest) plus the dedup/cap store is duplicated near-verbatim across `main.js` and `web/server.mjs` and drifts silently — a selector tweak in a capture script or an adapter hostname change must be patched in two places, and a dedup-window change in one backend quietly diverges from the other. Folding it into one DI-driven core kills the duplication and turns an effectful, hard-to-exercise lifecycle into a deep module fronted by a thin seam that fakes can drive. It also restores correct dedup: dedup needs a single store shared by both ingest paths, which only a shared core gives us. It preserves headless capture (the web server already ingests with no browser attached) and it is the prerequisite for the Slack-ready Notification Adapter seam (028), which adds `groupKey` + tagged `activate` on top of the entry shape this task centralizes.

## Acceptance criteria

- [ ] A repo-root CJS module `notifications-sidechain.js` exports `createNotificationCenter(deps)` where `deps = { readInject, listTargets, load, save, now, WebSocketCtor, onEntry }`.
- [ ] The center owns `ADAPTERS` + `adapterFor(url)`: `adapterFor` returns the matching Notification Adapter (by URL hostname) or `null`, and the matched adapter's name is stamped onto every entry as `entry.adapter`.
- [ ] The center owns the attach/reconcile lifecycle: calling `reconcile(targets)` opens a read-only Notification Side-Channel (via `WebSocketCtor`) for each adapter-matching Tab target not already attached, injects the adapter's capture script at document-start, and closes side-channels for targets that disappeared — with no screencast and no Input Forwarding (ADR-0003 preserved, no behavior change).
- [ ] Ingest from the `__cdpNotify` binding flows through the center's pure dedup + cap logic and store mutation; duplicate toasts within the dedup window are dropped, and the store is capped to the existing limit.
- [ ] The store exposes `list`, `markRead`, `markUnread`, `markAllRead`, `clear`, `unreadCount`, and persists through injected `load`/`save`.
- [ ] Every newly stored entry fires `onEntry(entry)` exactly once; backends do their platform effects there (Electron: `chromeSend` + OS `Notification` + dock badge gated by `shouldNotifyOs`; web: broadcast + `sendPushToAll`).
- [ ] `main.js` adopts the center, deleting its hand-rolled side-channel + store code; existing Electron notification behavior is unchanged.
- [ ] `web/server.mjs` adopts the center and runs it headless on the server lifecycle; capture + persistence + Web Push fire with no client connected.
- [ ] CONTEXT.md and CLAUDE.md updated to describe the shared center; ADR-0003 referenced (preserved, not superseded).
- [ ] `pnpm test` / `pnpm typecheck` / `pnpm check` green.

## Test plan

### Layer 1 — Pure logic (TDD)

Strict TDD on `notifications-sidechain.js` driven entirely by fakes (`fakeWebSocketCtor`, fake `readInject`/`listTargets`/`load`/`save`, controllable `now`, spy `onEntry`):

- [ ] `adapterFor` — returns the Teams adapter for a Teams URL, the Outlook adapter for an OWA URL, `null` for an unmatched host; match is by hostname not full URL.
- [ ] `reconcile` attach — given new adapter-matching targets, opens one side-channel per target and injects the adapter's capture script at document-start; non-matching targets get no socket.
- [ ] `reconcile` reconcile/drop — re-running with an unchanged target list opens no new sockets (idempotent); a target that disappears has its side-channel closed; a target whose URL changed to a non-matching host is dropped.
- [ ] ingest dedup — two identical toasts within the dedup window produce one stored entry and one `onEntry`; the same toast after the window produces a second.
- [ ] ingest cap — ingesting past the store cap evicts oldest first and never exceeds the cap.
- [ ] `entry.adapter` stamp — an ingested Teams toast yields `entry.adapter === 'teams'`; Outlook yields `'outlook'`.
- [ ] store mutations — `markRead`/`markUnread`/`markAllRead`/`clear` move `unreadCount` correctly and each persists via `save`; `list` returns the cap-ordered entries.
- [ ] `onEntry` once — each newly stored (non-duplicate) entry fires `onEntry` exactly once; a deduped toast fires zero.

### Layer 2 — Manual smoke (CDP/IPC)

Both backends, against a live Remote Browser with Teams + Outlook open in **background** Tabs:

- [ ] Electron (`pnpm dev`): receive a real Teams toast and a real Outlook toast in background Tabs → each lands in the bell, the per-origin badge increments, the OS `Notification` fires (gated), and clicking still activates the Tab. Confirm no duplicate entries vs the previous build.
- [ ] Web (`pnpm web`) with **no client connected**: trigger a Teams/Outlook toast on the remote → the entry appears in `/api/notifications` after a client connects, and a Web Push fires to a subscribed PWA while the page is backgrounded.
- [ ] Web with a client connected: a toast broadcasts in-band to the bell + per-origin badge, and is not double-counted against the headless capture.

### Layer 3 — Visual review

n/a — no renderer UI changes; the bell, badges, and popover consume the same entry shape and SSE/IPC pushes as before. Existing Layer 3 coverage from prior notification tasks stands.

## Design notes

This makes the Notification Side-Channel a **deep module**: a wide, messy lifecycle (multiplexed sockets, capture-script injection, dedup, cap, persistence) behind a narrow `createNotificationCenter(deps)` seam. The duplication across backends collapses to one core; both backends become thin effect adapters injected through DI. Locality improves — adapter config, match logic, lifecycle, and store live together — and leverage is high: 028 extends the entry shape and adapter config without touching either backend's wiring.

- **Contracts changed:**
  - notification entry — informal/duplicated shape per backend → one canonical shape produced by the center, now carrying `adapter: string` (the matched Notification Adapter name). `groupKey` + tagged `activate` are added by 028, not here.
  - Side-Channel ownership — `main.js` and `web/server.mjs` each owned a private attach/reconcile/ingest loop + store → both delegate to `createNotificationCenter`, supplying only effects.
- **New modules:** `notifications-sidechain.js` (repo-root CJS, DI, tested) — the shared Notification Side-Channel lifecycle + store, consumed by both backends. The existing pure `notifications.js` dedup/cap/gating helpers are reused (or absorbed) by the center, not re-implemented.
- **New ADR needed?** no — ADR-0003 (notifications side-channel) governs the behavior and is preserved unchanged; this is a no-behavior-change extraction. The Slack-ready seam in 028 may warrant its own ADR; this task only references ADR-0003.

```ts
// shape sketch (the module is CJS; this is the contract, not the syntax)
interface NotificationCenterDeps {
  readInject(scriptName: string): string;          // load a capture script's source
  listTargets(): Promise<TabTarget[]>;             // current Tabs to consider for attach
  load(): NotificationEntry[];                      // persisted store on startup
  save(entries: NotificationEntry[]): void;         // persist after each mutation
  now(): number;                                    // injectable clock (dedup window)
  WebSocketCtor: new (url: string) => WebSocketLike; // side-channel transport factory
  onEntry(entry: NotificationEntry): void;          // platform effects (one per new entry)
}

interface NotificationCenter {
  reconcile(targets: TabTarget[]): Promise<void>;   // attach/reconcile/drop side-channels
  list(): NotificationEntry[];
  markRead(id: string): void;
  markUnread(id: string): void;
  markAllRead(): void;
  clear(): void;
  unreadCount(): number;
  close(): void;                                     // tear down all side-channels
}

interface NotificationEntry {
  id: string;
  adapter: string;        // matched Notification Adapter name, stamped by the center
  // …existing fields (title, body, origin, targetEntity, ts, read, …)
}
```

## Out of scope

- The Slack-ready Notification Adapter seam — `groupKey`, tagged `activate` union, normalized capture-script output, the renderer activation registry, and the CONTEXT.md "Notification Adapter" sharpening all belong to 028.
- Adding a new Notification Adapter (Slack or otherwise) — only Teams + Outlook move, unchanged.
- Refactoring the renderer's bell / per-origin badge / notifications-view grouping — they consume the same entry shape and are untouched here.
- The unread aggregator one-pass rework — separate task.
- Refactoring `main.js` onto the rest of the shared core (settings, endpoints, connector) — separate tasks; this one moves only the notification center.

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

Dedup correctness is the load-bearing reason both backends must share one store: the headless web capture and the in-band client path would otherwise count the same toast twice. Keep `onEntry` strictly "fired once per new stored entry" so the gating/broadcast/push effects can't double-fire. The center must not import Electron, `node:http`, or `web-push` — all of that arrives through `deps`. Verify the Edge `PUT`/Chrome `GET` `/json` quirk is reached through injected endpoints, not hardcoded, so the center stays backend-agnostic. ADR-0003 stays the source of truth for *why* the side-channel exists; this task changes *where the code lives*, not the behavior.

---

_When task status flips to `done`, move this file to `done/`._
