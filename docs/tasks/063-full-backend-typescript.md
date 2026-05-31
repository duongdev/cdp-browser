# 063 — full backend TypeScript (core + main.js + server.mjs)

- **Status:** ready
- **Mode:** HITL
- **Estimate:** 1d
- **Ring:** n/a (v0.2 — deferred)
- **Depends on:** move shared core into `core/` (the in-flight `core/**` relocation must land first)
- **Blocks:** none

## Goal

Convert the whole backend off `.js`/`.mjs` and onto TypeScript: the shared `core/` modules, the Electron `main.js`, and the web `web/server.mjs`. After this task, every backend file is `.ts`, type-checked by `tsc --noEmit`, and runs **with no build step** via Node's native type-stripping — `pnpm web` runs `node web/server.ts` directly, and `electron .` loads `main.ts` (which `require`s `./core/*.ts`). Dual-consumption survives unchanged: `main.ts` consumes core via `require` and `server.ts` via ESM `import`, both pointing at the same `.ts` core files. No transpile output, no `dist/` for backend code, no `ts-node`/`tsx` runtime dep — just strip-and-run. The renderer is already TS and is out of scope here.

## Why now

The backend is the last untyped surface in the repo. The `core/` modules are the shared source of truth both backends consume (ADR-0008), and they're written in **erasable-only** syntax already — no `enum`, no `namespace`, no parameter-properties — so the conversion is **syntactically free**: rename `.js`→`.ts`, add types where they pay, and the emitted-after-stripping JS is byte-equivalent to today. Local and prod Node is **v24.15**, where native type-stripping is on by default for the `web/server` path, so that half is genuinely a no-build win right now. What holds this at v0.2 rather than v0.1 is **one unverified fact**: Electron is **42.2.0**, and whether *its* bundled Node strips types for `require("./core/x.ts")` is unproven in **dev** and — the real blocker — inside the **packaged electron-builder asar**. If Electron 42 can't strip types from a `require`d `.ts` at runtime in the packaged app, the Electron half can't ship buildless and we either gate `main.ts` behind a transpile step (defeating the zero-build premise) or keep `main.js` plain JS while only `core/` + `server` go TS. That question must be answered before the full conversion commits, so it's the first gate of this task.

## Acceptance criteria

- [ ] **Electron-42 strip verification (the gate — do this first).** A documented check proves whether Electron 42.2.0's bundled Node strips TypeScript types for `require("./core/x.ts")` **both** (a) in **dev** (`electron .` with `ELECTRON_DEV=1`) and (b) inside a **packaged electron-builder asar** (`pnpm dist:dir`, then launch the produced `.app` and exercise a core `require`). The result is recorded in this file's Notes and in the ADR-0008 amendment. **If either path fails to strip:** stop the full conversion, fall back to the **scoped outcome** (core + `web/server` go `.ts`; `main.js` stays plain JS, requiring the `.ts` core only if dev+asar strip works for `require`d `.ts`, else keeping a JS shim) and split the Electron-main conversion into a follow-up task referenced in Notes. Either outcome closes this task; the decision and evidence are the deliverable.
- [ ] **Core converted, erasable-only preserved.** Every module under `core/` is `.ts` (`*.js` → `*.ts`), uses only erasable syntax (no `enum`/`namespace`/parameter-properties — verify, don't assume), and exports the **same runtime shape** as before (same named/default exports, same DI factories). The co-located `core/*.test.ts` suites import the `.ts` modules directly and stay green with no behavior change.
- [ ] **`web/server.mjs` → `web/server.ts`.** The web backend is `.ts`, run via `node web/server.ts` (native strip on Node 24) with **no build step** for the server itself; `pnpm web` / `pnpm web:serve` are updated to point at `web/server.ts`. Its ESM `import`s of `core/*` resolve to the `.ts` core (extension handling per the chosen import convention) and the web build boots and serves end-to-end.
- [ ] **`main.js` → `main.ts`** *(only if the gate passes for dev **and** asar; otherwise scoped per the gate's fallback).* Electron loads `main.ts` (`package.json` `main` updated), and its `require("./core/*")` calls resolve to the `.ts` core at runtime, in dev and in the packaged asar. The Electron app boots, connects, screencasts, and forwards input identically to before.
- [ ] **Dual-consumption preserved.** The same `.ts` core files are consumed by `main.ts` via `require` **and** `web/server.ts` via ESM `import` with no per-backend fork — one core, two consumers, both working. The require/import **extensions** are updated to whatever the strip-runtimes require (e.g. explicit `.ts` in ESM imports, the `require` form Electron's loader accepts) and documented as the convention.
- [ ] **`build.files` updated.** The electron-builder allowlist ships the `.ts` core (e.g. `core/**/*.ts` plus the test excludes `!core/**/*.test.ts`) and `main.ts`, replacing the current `.js`/`main.js` entries, so nothing the packaged runtime loads is stripped from the asar. The packaged app launches with **no** `Cannot find module` for any core file (this is co-verified by the asar half of the gate).
- [ ] **`tsc --noEmit` covers the backend.** `pnpm typecheck` now type-checks `core/`, `main.ts`, and `web/server.ts` (tsconfig `include`/`exclude` adjusted as needed), and is clean. `pnpm check` (Biome) is clean on the touched files. `pnpm test` and `pnpm test:e2e` are green (the e2e harness spawns `web/server.ts`).
- [ ] **ADR-0008 amended.** An append-only amendment to `docs/adr/0008-defer-monorepo-shared-cjs-core.md` records that the shared core (and the backends) move from plain CJS `.js` to type-stripped `.ts`, why (zero-build still holds via native strip), the Electron-42 asar evidence, and that the no-monorepo / DI / repo-`core/` decisions are otherwise unchanged. This explicitly revisits ADR-0008's "plain CommonJS `.js`" wording.
- [ ] **Docs reflect the new extensions.** CLAUDE.md (File Structure + the web-build paragraph that names `cdp-endpoints.js`, `settings-store.js`, `notifications-sidechain.js`, `remote-page-connector.js`, `line-splitter.js`, `web/server.mjs`) and CONTEXT.md are updated to the `.ts` filenames and the `node web/server.ts` run command.

## Test plan

Per [../conventions/tdd.md](../conventions/tdd.md). This is a mechanical re-extension + typing pass over already-tested modules; the **existing** `core/*.test.ts` suites are the regression net — they must stay green against the `.ts` sources with no edits beyond the import path/extension. The novel risk is entirely **runtime strip behavior** (dev + asar), which is Layer-2 manual smoke, not pure logic.

### Layer 1 — Pure logic (TDD)

- [ ] n/a for new logic — no behavior changes. The conversion is type-only/extension-only. Existing `core/*.test.ts` (cdp-endpoints, settings-store, notifications, notifications-sidechain, remote-page-connector, theme-emulation, line-splitter, crypto-envelope, frame-ack-gate, frame-throttle, quality-tier) must remain green importing the `.ts` modules. If any test needs an import-path/extension edit to resolve the `.ts` module, that edit is mechanical, not a logic change.

### Layer 2 — Manual smoke (CDP/IPC) — this is the load-bearing verification

- [ ] **Gate, dev:** `ELECTRON_DEV=1 electron .` boots; a core `require("./core/...")` is exercised (settings load, `/json` endpoint build, notification side-channel) — types stripped, no syntax error at load. Record pass/fail.
- [ ] **Gate, asar:** `pnpm dist:dir` then launch the produced `.app`; exercise the same core `require` path — confirm **no** `Cannot find module` and types stripped inside the packaged asar. Record pass/fail. **This is the blocker; if it fails, take the scoped fallback.**
- [ ] **Electron parity** (if `main.ts` ships): connect to a live Remote Browser, screencast renders, input forwards, tab switch settles, notifications fire — identical to the `.js` build.
- [ ] **Web parity:** `pnpm web` boots `node web/server.ts`; connect, screencast over WS and the SSE+POST fallback, input lands, notifications captured headless — identical to the `.mjs` build. `pnpm test:e2e` (which spawns the server) green.

### Layer 3 — Visual review

- [ ] n/a — no renderer or UI change. The screencast canvas, sidebar, toolbar, and overlays are untouched; behavior is observed only via the Layer-2 web/Electron smoke.

## Design notes

The change is **extension + types**, not logic. Because the core is erasable-only, stripping types yields the same runtime, so the conversion's correctness reduces to two questions: (1) do the run-targets strip types at load, and (2) do the `require`/`import` resolvers find the `.ts` files. Node 24 answers (1) yes for the web path. Electron 42's bundled Node is the unknown — its Node version determines whether `--experimental-strip-types` (or the now-default behavior) applies to `require`d `.ts`, and whether the asar's virtual filesystem interferes with the loader's `.ts` resolution. That is why the gate runs first and the asar smoke is mandatory.

- **Contracts changed:** none at the module level — same exports, same DI factories, same `CdpBridge`/connector/side-channel shapes. The only changed "contract" is **file extension + the require/import form** the backends use to reference core, plus `package.json` `main`, the `web` scripts, and `build.files`.
- **New modules:** none. Renames only (`core/*.js` → `core/*.ts`, `main.js` → `main.ts`, `web/server.mjs` → `web/server.ts`).
- **New ADR needed?** No new ADR — an **amendment to ADR-0008** (append-only), since this revisits that record's explicit choice of plain-CJS `.js` for the shared core.

```ts
// dual-consumption stays one core, two callers — only the extension form changes
// main.ts (CJS, Electron loader):
const endpoints = require("./core/cdp-endpoints"); // → resolves cdp-endpoints.ts at runtime (gate proves this in asar)
// web/server.ts (ESM, Node 24):
import endpoints from "../core/cdp-endpoints.ts";  // explicit .ts per ESM strip resolution
```

## Out of scope

- **Renderer (`src/`)** — already TypeScript; not touched.
- **Adopting the connector / settings-store / endpoints into `main.js`** (t032 and friends) — orthogonal; this task only re-extensions whatever `main` already consumes. Don't fold the t032 adoption into this.
- **The `pnpm` monorepo** — still deferred (ADR-0008 / ADR-0010). This keeps the repo-`core/` shape; it does not promote to `packages/core`.
- **Adding a transpile/bundle step for the backend** — explicitly rejected; the whole point is zero-build via native strip. If the Electron gate fails, the fallback is *scoping the conversion*, **not** introducing a build step for `main`.
- **New runtime deps** (`tsx`, `ts-node`, `swc`) — not adopted; native strip only.
- **Typing the renderer's `window.cdp`/`window.local` global shims more strictly** — separate cleanup.

## Definition of Done

All must be true before status → done.

- [ ] Layer 1 — existing `core/*.test.ts` suites green against the `.ts` sources (no logic edits)
- [ ] Layer 2 — Electron-42 strip gate recorded (dev + asar), and web (+ Electron if shipped) parity smoke completed with a live Remote Browser
- [ ] Layer 3 — n/a (no UI touched)
- [ ] `pnpm check` clean (Biome — lint + format) on touched files
- [ ] `pnpm typecheck` clean (now covering `core/`, `main.ts`, `web/server.ts`)
- [ ] `pnpm test` green and `pnpm test:e2e` green (server spawned as `.ts`)
- [ ] `pnpm web` boots `node web/server.ts` cleanly; `electron .` (or the packaged `.app`) boots cleanly per the gate outcome
- [ ] `build.files` updated to ship the `.ts` core + `main.ts`; packaged app launches with no `Cannot find module`
- [ ] ADR-0008 amended (append-only) with the strip rationale + Electron-42 asar evidence
- [ ] CLAUDE.md + CONTEXT.md updated to the `.ts` filenames and `node web/server.ts`
- [ ] No commented-out code, no `console.log` debris, no AI attribution
- [ ] Task closed: status → done, file moved to `docs/tasks/done/`, t063 in commit

## Notes

- **Hard precondition:** the in-flight `core/**` relocation (the move that renamed root `*.js` → `core/*.js` and repointed `main.js`/`web/server.mjs`) must land first. This task re-extensions those same files; doing both in one churn invites a messy diff.
- **Run the Electron gate before converting anything else.** It's the one fact that decides whether this is a *full* backend conversion or a *scoped* one (core + web only, `main.js` left as JS). Record the Node version Electron 42.2.0 bundles and the strip flag/default it honors, plus the dev and asar pass/fail. Everything downstream branches on this.
- **Erasable-only is a standing constraint, not a one-time check.** The core stayed `enum`/`namespace`/param-property-free deliberately so strip-and-run works. Note in CLAUDE.md / code-quality that backend `.ts` must remain erasable-only (no syntax that needs real codegen) so the no-build property holds.
- **asar + `.ts` resolution is the sharp edge.** electron-builder packs into an asar; the `.ts` files must be in `build.files` *and* the Electron loader must resolve a `.ts` `require` from inside the asar. The packaging-allowlist failure mode (a runtime-loaded file stripped from the asar → `Cannot find module`) is exactly the trap CLAUDE.md warns about — re-verify after the extension change, don't assume the old `.js` allowlist carries over.
- **Scoped fallback, if the gate fails:** ship `core/*.ts` + `web/server.ts`; keep `main.js` as JS (it can still `require` the `.ts` core only if dev+asar strip a `require`d `.ts` — otherwise main stays on a JS core path and the Electron-main TS conversion becomes a follow-up task once Electron's bundled Node catches up). Record the follow-up task ID here.

---

_When task status flips to `done`, move this file to `done/`._
