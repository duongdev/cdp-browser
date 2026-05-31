# 036 — inject version + git SHA into build; GET /api/version

- **Status:** done
- **Mode:** AFK
- **Ring:** inner
- **Slice:** 0-scaffolding
- **Estimate:** 0.5d
- **Depends on:** t035 (reset `package.json` 2.0.0 → 0.1.0)
- **Blocks:** t044 (per-build SW cache + update-available reload prompt), t050 (show version + build SHA in settings About row)

## Goal

After this ships, every build of the web PWA is self-identifying. The bundle carries two compile-time constants — `__APP_VERSION__` (from `package.json`) and `__GIT_SHA__` (from `git rev-parse --short HEAD` at build) — and the web server answers `GET /api/version` with `{ version, sha }`. From an installed iPad PWA you can confirm which build is running; from a shell you can `curl /api/version` to confirm a deploy actually landed; and the per-build artefacts (SW cache name, the settings About row, the `/prod-deploy` SHA assertion) finally have a real value to key off instead of a hardcoded string.

## Why now

This is Slice 0 scaffolding for the v0.1.0 gate: the release surface is the web PWA, and a release you can't identify after install is not shippable. Two inner-ring tasks are blocked on it. t044's per-build service-worker cache needs a build-unique token to bust the cache and trigger the update-available prompt — today the cache name is the static literal `"cdp-portal-v1"` in `public/sw.js`, so a new deploy never invalidates the old cache. t050's settings About row needs a version/SHA to display. It also lets `/prod-deploy` assert the deployed SHA matches what was pushed, closing the "did my redeploy land?" loop the prod-deploy memory note flags. Cheap, low-risk, unblocks two; do it first.

## Acceptance criteria

- [ ] `vite.config.ts` defines `__APP_VERSION__` and `__GIT_SHA__` via the Vite `define` option. `__APP_VERSION__` is read from `package.json` `version`; `__GIT_SHA__` is the short SHA from `git rev-parse --short HEAD` at build time.
- [ ] A failed/absent `git` call (e.g. building outside a git checkout, as in a Docker build context with no `.git`) does not break the build — `__GIT_SHA__` falls back to a stable sentinel (`"unknown"`), never throws.
- [ ] Both constants are declared in `src/vite-env.d.ts` as `declare const __APP_VERSION__: string` / `declare const __GIT_SHA__: string` so renderer code can reference them with full typing and `pnpm typecheck` stays clean.
- [ ] `web/server.mjs` reads the version + SHA through a `__APP_VERSION__`/`__GIT_SHA__` placeholder seam that mirrors the existing `__APP_TITLE__` injection (env-var-driven, with a sane fallback) — no new dependency on a build artefact the server can't see.
- [ ] `GET /api/version` returns `200` with JSON `{ version, sha }` (no E2E sealing — it must be `curl`-able plaintext for deploy verification, like the title rewrite path). It works whether or not E2E mode is on.
- [ ] `node --check web/server.mjs` passes; booting the server and hitting `GET /api/version` returns the expected shape.
- [ ] `pnpm build` produces a bundle whose `__APP_VERSION__` matches the current `package.json` version and whose `__GIT_SHA__` matches `git rev-parse --short HEAD`.
- [ ] No `console.log` debris, no AI attribution. `pnpm check`, `pnpm typecheck`, `pnpm test` all clean.

## Test plan

### Layer 1 — Pure logic (TDD)

The core is build glue (Vite `define` + server placeholder), which is not unit-testable on its own. If — and only if — the version-string assembly grows past a trivial expression, extract a tiny pure helper (e.g. `buildVersion(pkgVersion, sha) → { version, sha }`, or a `safeGitSha(exec)` that returns `"unknown"` on throw) into a root CJS module and TDD it:

- [ ] `safeGitSha` — returns the trimmed short SHA when the exec succeeds
- [ ] `safeGitSha` — returns `"unknown"` when the exec throws (no git / not a checkout)

If the logic stays a one-liner inline in `vite.config.ts`, this is "n/a — build glue, covered by the Layer 2 boot check."

### Layer 2 — Manual smoke (CDP/IPC)

No live Remote Browser required — this verifies the build constants and the new HTTP route only.

- [ ] `pnpm build`, then grep the emitted `dist/` JS for the literal current `package.json` version and the current short SHA → both are present (proves `define` substitution fired).
- [ ] `node --check web/server.mjs` → exits 0.
- [ ] Boot the web server (`pnpm web`, or `node web/server.mjs` against built `dist/`) and `curl -s localhost:<port>/api/version` → returns `{ "version": "0.1.0", "sha": "<shortsha>" }`; the route also returns valid JSON with E2E mode enabled (it is not sealed).
- [ ] Build with `.git` unreachable (e.g. `git`-less env or stubbed failing exec) → build still succeeds and `__GIT_SHA__` resolves to `"unknown"`.

### Layer 3 — Visual review

n/a — no renderer UI is added in this task. The version/SHA only appears on screen once t050 renders the About row; this task stops at the data being available (the constants + the endpoint).

## Design notes

Two independent injection paths feed the same two values into the two runtimes (browser bundle and Node server), each through that runtime's existing seam — no new shared transport, no new ADR.

- **`vite.config.ts`** — add a `define` block reading `version` from `package.json` and the short SHA from `child_process.execSync("git rev-parse --short HEAD")`, wrapped so a throw yields `"unknown"`. Both are `JSON.stringify`'d into `__APP_VERSION__` / `__GIT_SHA__` (Vite `define` does textual replacement, so values must be valid source literals). This is the browser-side path; the renderer reads the constants directly.
- **`src/vite-env.d.ts`** — declare the two `const` globals so TypeScript sees them. This file already holds the `window.cdp` ambient types; the two `declare const` lines sit alongside the `/// <reference types="vite/client" />` at the top.
- **`web/server.mjs`** — the server does not consume the Vite bundle's defines (it serves the built `dist/` but runs its own Node code), so it gets its own seam mirroring `APP_TITLE`: `const APP_VERSION = process.env.APP_VERSION || <pkg version>` and `const GIT_SHA = process.env.GIT_SHA || "unknown"`, then a `if (p === "/api/version" && !POST) return json(res, { version: APP_VERSION, sha: GIT_SHA })` route added next to the existing `/api/config` routes. The deploy script (and Dockerfile) set `APP_VERSION`/`GIT_SHA` env vars at build/run time, exactly as they already set `APP_TITLE`. The server reading `package.json` directly for the default is acceptable since it is co-located.
- **Contracts changed:** `CdpBridge` gains nothing in this task (no `window.cdp` method) — the renderer reads the build constants directly, not over IPC/HTTP; the `/api/version` endpoint is a deploy/ops surface, not part of the `CdpBridge` contract. New global types `__APP_VERSION__: string`, `__GIT_SHA__: string`.
- **New modules:** none, unless the SHA helper is extracted (see Layer 1) — then one tiny root CJS module with a focused test.
- **New ADR needed?** no. This follows the existing `__APP_TITLE__` deploy-time-injection pattern (ADR-0006 web build) and the `package.json` version reset (t035); no architectural decision is made.

```ts
// vite.config.ts — conceptual shape (textual replacement, hence JSON.stringify)
define: {
  __APP_VERSION__: JSON.stringify(pkg.version),
  __GIT_SHA__: JSON.stringify(safeGitSha()), // "unknown" on throw
}
```

```jsonc
// GET /api/version
{ "version": "0.1.0", "sha": "c2c658c" }
```

## Out of scope

- Rendering the version/SHA anywhere in the UI — that is t050 (settings About row). This task only makes the data available.
- Changing the SW cache name or wiring the update-available reload prompt — that is t044, which consumes this build token.
- Electron version surfacing (`app.getVersion()` / electron-auto-update) — deferred to v0.2 per the locked v0.1.0 scope (release pipeline + version surfacing target the web build only).
- A `window.cdp` / `CdpBridge` method for version — not needed; the renderer reads the compile-time constants, and ops reads `/api/version`.
- The version reset itself (`package.json` 2.0.0 → 0.1.0 + `.release-please-manifest.json`) — that is the upstream dependency t035.
- Sealing `/api/version` under E2E — deliberately plaintext so a deploy can be verified through a TLS-intercepting proxy without the passphrase.

## Definition of Done

All must be true before status → done.

- [ ] Layer 1 tests written and green (if the SHA helper was extracted)
- [ ] Layer 2 smoke checklist completed (build constants present in `dist/`; `node --check` clean; `curl /api/version` returns `{ version, sha }`)
- [ ] Layer 3 screenshots captured and committed (if UI touched) — n/a here
- [ ] `pnpm check` clean (Biome — lint + format)
- [ ] `pnpm typecheck` clean
- [ ] `pnpm test` green
- [ ] `pnpm dev` boots cleanly and the changed surface works end-to-end
- [ ] CLAUDE.md updated for any modified module (note the `__APP_VERSION__`/`__GIT_SHA__` defines and the `/api/version` route in the Web build section)
- [ ] ADR written if an architectural decision was made — n/a
- [ ] No commented-out code, no `console.log` debris, no AI attribution
- [ ] Task closed: status → done, file moved to `docs/tasks/done/`, t036 in commit

## Notes

The git SHA must be resolved at build time, not committed — never write the SHA into a tracked file (it would be stale the moment the next commit lands). `execSync` in `vite.config.ts` runs in the build's working dir, so the SHA is whatever `HEAD` is at build. For Docker builds, the `.git` dir may be absent from the build context — that is exactly the `"unknown"` fallback case; the `GIT_SHA` env var (set by the build pipeline / Dockerfile `ARG`) is the reliable source there, which is why the server seam is env-var-first. Keep the server default (`package.json` version) and the Vite `define` in sync conceptually but don't share code across the CJS/ESM boundary just for one string — duplication of a single literal read is cheaper than a shared module here.
