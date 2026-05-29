# 030 — adopt shared settings store and endpoint builders in main process

- **Status:** done
- **Mode:** HITL
- **Estimate:** 0.5d
- **Depends on:** none
- **Blocks:** none

## Goal

Refactor `main.js` to consume the shared, already-tested core modules instead of
re-encoding their behaviour by hand. The settings object becomes a
`createSettingsStore` instance (schema, defaults, and the legacy
`switchBlur → switchEffect` / `bookmarks → pins` migrations all owned by one
module), with an injected writer that performs the actual `userData/settings.json`
write. Every inline `/json` URL template literal — including the Edge `PUT`
`/json/new` quirk — is replaced by a call to the `cdp-endpoints.js` request
descriptors. The IPC handlers (config, sidebar width, ui-state, pins, theme
source) collapse into thin forwards to the store. After this ships, the settings
schema and the CDP HTTP endpoint shape are defined in exactly one place and shared
by both the web build and the Electron main process; adding a setting or changing a
route is a single edit, not two that can drift.

## Why now

The web build already runs on `settings-store.js` + `cdp-endpoints.js`, but
`main.js` still carries its own copy of the same logic. The two have already
drifted once (the migration code lives in both), and every future setting or route
change has to be made twice or one side silently rots. This is the
ADR-0006-sanctioned de-dup follow-up — the explicit "main.js is not yet refactored
onto the shared core" note in CLAUDE.md. It unlocks nothing downstream on its own
(it is Electron-only cleanup, hence lowest priority and scheduled last), but it
removes a standing two-edit hazard and shrinks `main.js` toward a thin
effects-and-glue layer.

## Acceptance criteria

- [ ] `main.js` builds its settings object via `createSettingsStore({ initial, persist })`, where `initial` is the parsed `settings.json` (or `{}`) and `persist` writes the file. No hand-rolled `loadSettings`/`saveSettings` mutation+write pairs remain.
- [ ] The inline `switchBlur → switchEffect` and `bookmarks → pins` migration blocks in `main.js` are deleted; migration is inherited from the store and the resulting file is persisted on first load when a legacy key was present.
- [ ] Every `/json`, `/json/new`, `/json/close/{id}`, `/json/activate/{id}`, and `/json/version` request in `main.js` is built from a `cdp-endpoints.js` descriptor (`{ url, method }`); no `/json` string templates remain in `main.js`.
- [ ] `/json/new` still issues `PUT` (Edge quirk) because it comes from the shared `newTab` builder, not a local literal.
- [ ] The config, sidebar-width, ui-state, theme-source, and pin (`add`/`update`/`remove`/`reorder`/`get`) IPC handlers are thin forwards to the store's methods, persisting through the injected writer.
- [ ] Settings keys the store does not own (e.g. `localPins`, and any Electron-only persisted keys) still load and save correctly through the same store instance — no key is dropped from `settings.json`.
- [ ] `main.js` stays CommonJS and imports the cores by path (`require`), matching their CJS exports.
- [ ] `pnpm typecheck`, `pnpm check`, and `pnpm test` are clean (the cores' existing suites cover the moved logic).

## Test plan

### Layer 1 — Pure logic (TDD)

- [ ] `settings-store.js` (`createSettingsStore`) and `cdp-endpoints.js` are already covered by `settings-store.test.ts` and `cdp-endpoints.test.ts`; this task adds no new pure logic. By switching `main.js` onto these modules it inherits that coverage in place of running an untested duplicate. No new Layer 1 tests are required — only confirm the existing suites stay green.

### Layer 2 — Manual smoke (CDP/IPC)

Verify with `pnpm dev` against a live Remote Browser:

- [ ] Open settings, save a new CDP host/port (a known-good address) → the app reconnects and shows the Active Tab's Screencast Frame; the Tabs list reflects the new Remote Browser.
- [ ] Toggle a ui-state setting (e.g. Switch Effect or Adaptive Viewport), restart the app → the setting is restored from `settings.json` (store round-trips through the injected writer).
- [ ] Change theme source, create/rename/reorder/remove a Pin, restart → theme source and Pins persist exactly as before.
- [ ] Create a new Tab against an Edge Remote Browser → `/json/new` succeeds (PUT path preserved); the new Tab appears and connects.
- [ ] Start the app with a legacy `settings.json` (containing `switchBlur` and/or `bookmarks`) → it loads, migrates to `switchEffect`/`pins`, and re-persists the migrated shape; no crash, no lost keys.

### Layer 3 — Visual review

n/a — no renderer UI changes; this is main-process glue only. Settings and Pins are exercised through the existing UI during Layer 2 but their appearance is unchanged.

## Design notes

This is a substitution behind stable seams: the IPC contract the renderer sees
(`window.cdp` config/ui-state/pins/theme + tab list/new/close/activate) does not
change, and `settings.json` keeps the same on-disk schema. The change is purely in
who owns the settings mutations and the endpoint URLs inside `main.js`.

- **Contracts changed:** none externally. The renderer-facing IPC surface and the `settings.json` schema are unchanged. Internally, `main.js`'s ad-hoc settings mutation + write pairs are replaced by the `createSettingsStore` store contract, and its inline `/json` templates by the `cdp-endpoints.js` descriptor contract.
- **New modules:** none. This task only adopts the existing repo-root CJS cores (`settings-store.js`, `cdp-endpoints.js`) in `main.js`.
- **New ADR needed?** no. Already sanctioned by `docs/adr/0006-web-proxy-sse-transport.md` as a tracked follow-up; no new architectural decision is made.

Boundary detail to resolve explicitly during the work — the store owns a defined
schema (config, sidebar width, the ui-state keys, theme source, pins) but `main.js`
also persists Electron-only keys the store does not model (e.g. `localPins`). The
store is constructed over the full parsed `settings.json` and its `persist` writer
re-serialises the whole object, so unmodeled keys must survive untouched. Keys the
store does not expose a setter for are read/written directly on the same persisted
object, not forked into a second file.

```ts
// store wiring inside main.js (CJS), conceptual shape:
const store = createSettingsStore({
  initial: readJsonOrEmpty(settingsPath), // parsed settings.json
  persist: (settings) => writeJson(settingsPath, settings), // the one fs write
})

// endpoint usage replaces string templates:
const { url, method } = endpoints.newTab(host, port, targetUrl) // PUT for Edge
await fetch(url, { method })
```

## Out of scope

- Extracting the Remote Page connect/disconnect choreography onto a shared connector (the separate connector task).
- Adopting the shared cores in `web/server.mjs` (already done) or any web-build change.
- Modelling the Electron-only persisted keys (`localPins`, extension paths, media flags) into `settings-store.js`; they remain read/written on the persisted object as-is.
- Migrating `main.js` off CommonJS or to ESM imports.
- Any change to the IPC method names, the `settings.json` filename/location, or the on-disk schema.

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

When this lands, the "Note: `main.js` is not yet refactored onto the shared core —
a tracked follow-up" line in CLAUDE.md (Web build section) should be removed or
amended, since the follow-up is then complete. The cleanest sequencing is to wire
the store first (it touches the most handlers), verify persistence round-trips, then
swap the endpoint builders, which are independent and lower-risk. Watch that the
store's `getUiState` defaults match `main.js`'s current defaults exactly so no
toggle silently flips on upgrade.
