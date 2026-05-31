# 043 — fix updatePin to true partial patch (stop wiping url/title)

- **Status:** done
- **Mode:** AFK
- **Ring:** inner
- **Slice:** 1-never-stuck
- **Estimate:** 0.5d
- **Depends on:** none
- **Blocks:** none

## Goal

`updatePin(id, patch)` in `settings-store.js` is not a real partial patch. It
rebuilds the matched pin as `{ ...p, title: patch.title, url: patch.url }`, so any
caller that passes a patch missing `title` or `url` overwrites that field with
`undefined` — the saved title and URL are silently wiped. After this task,
`updatePin` merges the patch onto the existing pin and only the keys actually
present in the patch change; unpassed fields keep their stored value. The pin a
user pinned still has its title and URL after a partial edit on either backend.

## Why now

`settings-store.js` is shared-core: both `main.js` (Electron) and `web/server.mjs`
(the web PWA — the v0.1.0 release surface) call this exact function, so the wipe is
a data-loss footgun on the daily-driver iPad PWA. A pin losing its saved URL is a
"stuck" experience — the pinned holder no longer resolves to its app, which is
precisely the kind of never-stuck regression the v0.1.0 inner ring gates against.
It is pure store logic with an existing test file, so it is a cheap, strictly
testable win that closes a live correctness hole before release.

## Acceptance criteria

- [ ] `updatePin(id, patch)` merges `patch` onto the existing pin (`{ ...pin, ...patch }`), leaving every key not present in `patch` at its current stored value.
- [ ] A partial patch that contains only `title` keeps the pin's existing `url` (and vice versa) — no field is set to `undefined` by an absent patch key.
- [ ] A patch that carries extra pin fields (e.g. `targetId`, a future key) is merged through, not dropped.
- [ ] `updatePin` for an unknown `id` is a no-op on the pins array (other pins untouched) and still persists, matching current behaviour.
- [ ] The function still returns the updated `settings.pins` array and calls the injected `persist`.
- [ ] A new Layer 1 test reproduces the wipe (fails against the current code) before the fix, then passes after.

## Test plan

### Layer 1 — Pure logic (TDD)

Module under test: `settings-store.js` (`createSettingsStore(...).updatePin`),
covered in the existing `settings-store.test.ts`. Write the failing regression
case first, then make it pass.

- [ ] `updatePin` — partial patch `{ title }` only changes the title; the stored `url` (and any other field) is preserved (this case fails against the current hardcoded rebuild — the data-loss regression).
- [ ] `updatePin` — partial patch `{ url }` only changes the url; the stored `title` is preserved.
- [ ] `updatePin` — full patch `{ title, url }` updates both (keep/repurpose the existing line 54 case so the happy path stays covered).
- [ ] `updatePin` — patch with an extra key (e.g. `{ targetId: "X" }`) merges that key through without dropping `title`/`url`.
- [ ] `updatePin` — unknown `id` leaves all existing pins unchanged and still calls `persist`.

### Layer 2 — Manual smoke (CDP/IPC)

n/a — pure store logic; no main-process, IPC, or live Remote Browser path is
touched. The shared store has no fs/Electron dependency and is exercised entirely
through its public API in Layer 1.

### Layer 3 — Visual review

n/a — no renderer UI changes.

## Design notes

Single-function fix in one shared-core module; no contract, schema, or API-surface
change. The pin object shape (`{ id, url, title?, targetId?, ... }`) is unchanged —
only the merge semantics inside `updatePin` are corrected so callers passing a
subset of fields no longer clobber the rest.

- **Contracts changed:** `createSettingsStore(...).updatePin(id, patch)` — semantics only. Old: replaces the matched pin's `title`/`url` with `patch.title`/`patch.url` (absent keys → `undefined`, wiping them). New: shallow-merges `patch` onto the existing pin, mutating only keys present in `patch`. Signature and return value (`settings.pins`) unchanged.
- **New modules:** none.
- **New ADR needed?** no — bug fix that restores the function's documented intent (partial patch); no architectural decision.

```ts
// behavioral contract, not a file path
updatePin(id, patch) // → { ...existingPin, ...patch } for the matched id, others untouched
// e.g. updatePin("1", { title: "T2" }) on { id:"1", url:"u", title:"t" }
//      → { id:"1", url:"u", title:"T2" }   // url preserved, was wiped before
```

## Out of scope

- Modelling Electron-only persisted pin keys into the store (left as-is, ADR-0006 follow-up).
- Adopting `remote-page-connector.js` or any of the v0.2-deferred shared-core refactors (task 032).
- Any change to `addPin`/`removePin`/`reorderPins` semantics, the pin schema, or the renderer-facing IPC/REST surface.
- Validating or normalising patch contents (e.g. rejecting unknown keys) — the merge is intentionally permissive to carry future pin fields.

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

The existing `settings-store.test.ts` "updates a pin's title/url by id" case (line
54) passes a full `{ title, url }` patch, which is exactly why the bug slipped
through — it never exercises a partial patch. Add the partial cases alongside it
rather than replacing it. The fix itself is the one-line map body:
`p.id === id ? { ...p, ...patch } : p`.
