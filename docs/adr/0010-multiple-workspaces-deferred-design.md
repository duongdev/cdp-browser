# ADR-0010: Multiple workspaces — deferred design sketch (multi-CDP-host, Arc-style)

- **Status:** Proposed
- **Date:** 2026-05-30

This ADR records the **design** for the next big feature so the v0.1.0 work doesn't paint it into a corner. It is **not** built in v0.1.0 — hence Status: Proposed. It is ratified and broken into tasks when the work starts (targeted v0.2).

## Context

The user wants Arc-style **workspaces**: connect to **multiple CDP hosts**, kept as separated workspaces on the same window, switched via `Ctrl+number` or a horizontal swipe on the sidebar (iPad). Today the app holds a single flat config `{host, port, pins, ...}` and a single live **Remote Page** (ADR-0001). The open questions are whether multi-host workspaces **violate** the single-Remote-Page constraint, and how the data model, UI, and web server should be shaped to absorb them without a rewrite.

## Decision

This is a **sketch to be ratified** when the work starts. The shape:

- **Mental model.** One workspace = one CDP host endpoint = one remote browser identity (profile-as-app semantics, like Sidekick/Orion — **not** Vivaldi-style tab-grouping within one browser). Session isolation is whatever the remote browsers themselves provide: strong when hosts differ, none when two workspaces point at the same `host:port`. So surface `host:port` per workspace and warn on collision.
- **Single-Remote-Page is scoped, not violated.** Exactly **one** workspace's active target streams (screencast + input) at a time; dormant workspaces keep only their config plus their read-only notification side-channels — already blessed by ADR-0003 (multiple CDP clients per target on Edge 148). Add a one-line note to ADR-0001 that its rule is now scoped by this ADR: it governs the single *streaming* session, which is now per-active-workspace.
- **Data model.** `settings-store` gains `workspaces: [{ id, name, color, host, port, pins: Pin[] }]` + `activeWorkspaceId`. App-global keys (theme, sidebar width, `switchEffect`, transport mode, `webPush`, quality tier) stay top-level. Extend the existing `migrate()` (the same seam that did `switchBlur`→`switchEffect` and `bookmarks`→`pins`) to wrap today's flat `{host, port, pins}` into `workspaces[0]` named `'Default'`. `getConfig`/`getPins`/etc. delegate to the active workspace for back-compat.
- **Web server.** Replace the single `remotePage` connector + `notificationCenter` with a `Map<workspaceId, {connector, notificationCenter}>`. Only the active workspace owns the screencast socket + SSE/WS fan-out; **all** notification centers run headless on the reconcile loop. `/api` endpoints take a `workspaceId` (default = active). Every notification entry is stamped with `workspaceId`. This must not regress single-workspace latency — split the build into (a) registry + active-routing, (b) per-workspace notification fan-out.
- **Switch choreography.** Synchronously swap sidebar chrome (pins, color) + set the viewport to `'connecting'`, **then** re-point `host`/`port` and let the connector run. Reuse the existing `connectId` race-guard (cancels an in-flight connect on rapid switch) + the `switchEffect: 'blur'` freeze so the last frame dims instead of flashing white. Per-workspace tab / MRU / closed-stack state via `Map<workspaceId, ...>`.
- **UI.** Arc-style colored pill strip at the sidebar bottom; click switches, `+` creates, right-click manages. `Ctrl+1..9` for direct jump (`Cmd+1..9` is already taken by tab index) — it **must** `preventDefault` before Input Forwarding so it doesn't leak to the remote page (`key-routing.ts` currently only guards Cmd-combos). iPad: a single-finger horizontal pan scoped to the strip with `touch-action: pan-y`, a distance+velocity threshold, kept inboard of the screen edges (avoid the iPadOS system back-swipe), and not fighting dnd-kit's `PointerSensor`.
- **Phased breakdown (v0.2).** ADR ratify → `Workspace` type + color tokens → data-model + migration (TDD) → pure switcher module `src/lib/workspaces.ts` (`next`/`prev`/`byIndex`, TDD) → server per-workspace routing (split ×2) → switcher UI + `Ctrl+number` → switch choreography → notifications scope → active-order scoping → iPad swipe.

## Consequences

**Easier:**
- The single-active-stream model means **no new concurrency** versus today's screencast — only one workspace renders, so latency/bandwidth are unchanged.
- Notifications already support background side-channels (ADR-0003), so dormant-workspace badges fall out of the existing reconcile loop.
- The settings `migrate()` seam already exists, so the flat→workspaces upgrade is a small, tested addition.

**Harder:**
- The web server's `connector`/`notificationCenter` singletons become keyed maps — this is the crux (XL, high risk).
- Per-workspace scoping of tab / MRU / closed / active-order state.
- Not regressing single-workspace latency through the new routing layer.
- The `Ctrl+number` key-leak guard and the iPad-swipe gesture conflicts (dnd-kit, system back-swipe).

## Alternatives

- **Multiple windows/tabs of the PWA instead of in-app workspaces** — rejected: loses the unified sidebar, cross-workspace notification badges, and the instant switch.
- **One browser, many profiles via tab-grouping (Vivaldi model)** — rejected: doesn't satisfy multi-CDP-**host**.
- **Lift the single-Remote-Page constraint to stream N workspaces at once** — rejected: N concurrent screencasts blow latency/bandwidth on a thin iPad link for no benefit, since only one is ever visible.
