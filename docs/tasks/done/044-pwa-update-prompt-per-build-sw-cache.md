# 044 — per-build SW cache + update-available reload prompt

- **Status:** done
- **Mode:** HITL
- **Slice:** 1-never-stuck
- **Ring:** inner
- **Estimate:** 1d
- **Depends on:** build-version-injection-and-api-version-endpoint
- **Blocks:** none

## Goal

Make the installed iPad PWA notice and adopt new builds instead of being stranded on a stale shell. Today `public/sw.js` uses a fixed cache name (`cdp-portal-v1`) and calls `skipWaiting()` on every install, so old cache entries are never purged on version change and there is no signal to the running page that a fresh build shipped. After this task the service-worker cache is named per build (`cdp-portal-${version}-${sha}`), old caches are deleted on `activate`, the unconditional `skipWaiting()` is gone, and when a new worker is waiting the page shows a dismissible "Update available — reload" sonner toast. Tapping it activates the new worker and reloads. This is the PWA's auto-update path.

## Why now

"Never-stuck" is the v0.1.0 release gate, and a PWA pinned on a stale shell is the worst kind of stuck — the user has no in-app way to know a fix shipped or to pull it. Electron auto-update is explicitly deferred to v0.2 (web PWA is the release surface), so the web update prompt is the *only* update mechanism v0.1.0 ships. It depends on the build identifying itself: this task consumes the `version` + `sha` produced by `build-version-injection-and-api-version-endpoint` to name the cache, so it lands after that. It is part of the inner ring and is checked under the t018 iPad workday verification gate.

## Acceptance criteria

- [ ] SW cache name is per build: `cdp-portal-${version}-${sha}` (values injected at build time, not hardcoded `v1`).
- [ ] On `activate`, every cache whose name is not the current per-build name is deleted (`caches.keys()` → filter → `caches.delete`), wrapped in `event.waitUntil`.
- [ ] The unconditional `self.skipWaiting()` in the `install` handler is removed; the new worker enters `waiting` and does not take over until the user opts in.
- [ ] The page detects a waiting/installed update via `registration` (`updatefound` → new worker reaches `installed` while a controller exists) and shows a dismissible sonner toast: "Update available" with a "Reload" action.
- [ ] Tapping "Reload" posts `SKIP_WAITING` to the waiting worker; the SW handles that message with `self.skipWaiting()`; the page reloads once on the next `controllerchange`.
- [ ] The toast is dismissible without reloading (user can keep working and reload later); it does not auto-reload or steal focus.
- [ ] `registration.update()` is called on `visibilitychange` when the document becomes visible, so returning to a backgrounded PWA checks for a new build.
- [ ] First install (no existing controller) does NOT show the update toast — `updatefound` on a fresh registration is silent.
- [ ] The reload happens at most once per update (a `controllerchange` reload guard prevents a reload loop).
- [ ] Web Push (`push` / `notificationclick`) and the existing fetch routing (network-first navigations, cache-first hashed assets, `/api/*` pass-through) are unchanged in behavior — only the cache name and lifecycle change.

## Test plan

### Layer 1 — Pure logic (TDD)

A pure cache-name builder is the only extractable logic; extract it only if it earns its keep (it removes a string-template typo risk shared by the SW and any tooling that pre-warms the cache).

- [ ] `cacheNameFor(version, sha)` — returns `cdp-portal-${version}-${sha}`; covers normal values.
- [ ] `cacheNameFor` — covers missing/empty `sha` (falls back to `version` only, never bare `cdp-portal-`).
- [ ] `isStaleCache(name, current)` — true for any `cdp-portal-*` name that is not `current`; false for `current` and for unrelated cache names (don't delete caches we don't own).

If the builder is not extracted (SW-inline is judged simpler), this layer is "n/a — SW lifecycle glue only" and Layers 2–3 carry the task.

### Layer 2 — Manual smoke (deploy + reload)

HITL — needs two deployed builds (no live Remote Browser required; this is pure SW/shell behavior). Use desktop Chrome (Application → Service Workers) first, then confirm on iPad PWA.

- [ ] Build A installed; DevTools shows cache `cdp-portal-<A>`. Build B deployed; reload the tab → SW updates, "Update available" toast appears, no auto-reload.
- [ ] Tap "Reload" → page reloads once, now controlled by Build B's worker; DevTools shows only `cdp-portal-<B>` (Build A's cache purged).
- [ ] Dismiss the toast instead of reloading → page keeps working on Build A; the waiting worker stays waiting; reloading later still adopts Build B.
- [ ] Background the PWA, deploy Build C, foreground it → `visibilitychange` triggers `registration.update()`, toast appears.
- [ ] Fresh install (clear site data, install Build C) → no update toast on first load.
- [ ] iPad PWA: repeat the deploy→toast→Reload path; confirm no stale shell and a single reload.

### Layer 3 — Visual review

- [ ] Update toast rendered via Chrome MCP against a simulated waiting worker (e.g. register an old SW, deploy a new one) — screenshot the toast with its "Reload" action.
- [ ] Toast is dismissible (X / swipe) and matches the existing `Toaster` placement/style (`bottom-right`, richColors).
- [ ] iPad-physical capture of the toast in the installed PWA is HITL (flagged for t018).

## Design notes

Behavioral change, not a path walk:

- **`public/sw.js`** — replace the constant `CACHE = "cdp-portal-v1"` with a per-build name composed from build-injected `version` + `sha` (consumed from `build-version-injection-and-api-version-endpoint`). Remove `self.skipWaiting()` from the `install` handler. Extend the `activate` handler to also purge stale `cdp-portal-*` caches (it already does `clients.claim()`). Add a `message` handler that calls `self.skipWaiting()` on `{ type: "SKIP_WAITING" }`. The `fetch`, `push`, and `notificationclick` handlers are untouched.
- **`src/main.tsx`** — `navigator.serviceWorker.register("/sw.js")` already runs here (web build only, behind `window.webCaps`). Keep registration here; surface the returned `registration` to the update-watcher so the watcher does not re-register.
- **`src/app.tsx`** — host the update watcher (the `Toaster` is already mounted here at `bottom-right richColors`, and `toast` is already imported from `sonner`). On `registration.updatefound`, watch the new worker's `statechange`; when it reaches `installed` *and* `navigator.serviceWorker.controller` exists (i.e. not first install), fire `toast("Update available", { action: { label: "Reload", onClick: postSkipWaitingAndReload } })`. Reload on the next `controllerchange`, guarded by a module-level boolean so it fires once. Add a `visibilitychange` listener that calls `registration.update()` when `document.visibilityState === "visible"`.

- **Contracts changed:** SW cache identity moves from a constant to a build-derived name; SW gains a `SKIP_WAITING` message protocol. No renderer type/IPC contract changes.
- **New modules:** optional `sw-cache-name.ts` (pure `cacheNameFor` / `isStaleCache`) iff Layer 1 is taken; otherwise none. No new component — the toast reuses the existing sonner `Toaster`.
- **New ADR needed?** no — this is the web update mechanism implied by the locked v0.1.0 release plan (web PWA = the release surface; Electron auto-update deferred to v0.2). If the build-injection mechanism it depends on warrants a record, that ADR belongs to the dependency task, not this one.

```ts
// pure, if extracted
function cacheNameFor(version: string, sha?: string): string // "cdp-portal-0.1.0-ab12cd3"
function isStaleCache(name: string, current: string): boolean // owns only cdp-portal-* names
```

Update flow (no new transport, all browser-native SW lifecycle):

```
new build deployed
  → registration.update() (on load + visibilitychange)
  → updatefound → newWorker.statechange === "installed" && controller exists
  → toast "Update available" [Reload]
  → onClick → waiting.postMessage({ type: "SKIP_WAITING" })
  → sw: skipWaiting() → controllerchange → location.reload() (once)
```

## Out of scope

- Electron auto-update / version surfacing — deferred to v0.2 (web PWA is the only v0.1.0 release surface).
- The build-time `version` + `sha` injection and the `/api/version` endpoint themselves — owned by `build-version-injection-and-api-version-endpoint` (this task only *consumes* the values).
- Surfacing the running version in the UI (about/status line) — separate concern; not required for the update prompt.
- Background-precaching / offline manifest precache lists, Workbox adoption, or changing the `fetch` caching strategy — keep the existing network-first-navigation / cache-first-asset logic as-is.
- A command-palette or settings entry for "check for updates" — the OUTER-ring command palette (v0.1.1) can add one later; not in this task.

## Definition of Done

All must be true before status → done.

- [ ] Layer 1 tests written and green (if the pure cache-name builder is extracted)
- [ ] Layer 2 smoke checklist completed with two deployed builds (no live Remote Browser required)
- [ ] Layer 3 screenshots captured and committed (if UI touched)
- [ ] `pnpm check` clean (Biome — lint + format)
- [ ] `pnpm typecheck` clean
- [ ] `pnpm test` green
- [ ] `pnpm dev` boots cleanly and the changed surface works end-to-end
- [ ] CLAUDE.md updated for any modified module (note the per-build cache + update-prompt behavior alongside the existing PWA description)
- [ ] ADR written if an architectural decision was made (expected: none)
- [ ] No commented-out code, no `console.log` debris, no AI attribution
- [ ] Task closed: status → done, file moved to `docs/tasks/done/`, t044 in commit

## Notes

- The existing SW comment block documents the fetch-routing contract (network-first navigations, cache-first hashed assets, `/api/*` never intercepted, "See t011") — preserve it; only the cache name and lifecycle change.
- The dependency is referenced by id (`build-version-injection-and-api-version-endpoint`), not number, because that task may be authored/numbered separately in the v0.1.0 release-tooling batch. Confirm its injected `version`/`sha` shape before wiring the cache name.
- Guard against StrictMode double-invoke in dev: the update watcher and `visibilitychange` listener must be idempotent (single registration, single reload). The web SW path only runs when `window.webCaps` is set, so Electron is unaffected.

---

_When task status flips to `done`, move this file to `done/`._
