# 037 — CI gate: typecheck + test + hermetic e2e + build smoke + node --check

- **Status:** done
- **Mode:** AFK
- **Estimate:** 1d
- **Ring:** inner
- **Slice:** 0-scaffolding
- **Depends on:** none
- **Blocks:** release-please-pipeline-and-engines-bump

## Goal

Stand up the project's first CI gate so a broken push can't reach prod again. Add
`.github/workflows/ci.yml`, triggered on every pull request and every push to
`main`, that runs the real green-bar checks: `pnpm typecheck`, `pnpm test`, the
hermetic `pnpm test:e2e` suite (run explicitly because it's excluded from
`pnpm test`), a `pnpm build` smoke (the renderer compiles + bundles), and
`node --check web/server.mjs` (the web backend parses). Biome runs **scoped to the
files changed in the PR**, not a pristine `pnpm check`, because a clean checkout
already fails Biome on pre-existing errors in untouched files. After this task, a PR
that breaks typing, a test, the hermetic transport e2e, the bundle, or the web
server's syntax is blocked at the PR before it can be merged and deployed.

## Why now

The daily driver is the web PWA on iPad, deployed to the prod target.
The current state is "verify by hand or 502 prod": there is no CI, and a single ESM
import error has already 502'd prod and burned a deploy cycle (MEMORY:
verify-locally-before-deploy). v0.1.0 is the first cut we actually tag and ship, and
the locked scope makes this the v0.1.0 CI gate — carved out of the old task 003,
which kept the signed-mac Electron release and the Claude-bot workflows but marked
them deferred to v0.2. The release slice can't move without it: the release-please
pipeline task (038) gates its release PRs on this CI passing, so this lands first.

## Acceptance criteria

- [ ] `.github/workflows/ci.yml` exists and triggers on `pull_request` (any branch) **and** `push` to `main`.
- [ ] The job uses pnpm (corepack/`pnpm/action-setup`) and Node pinned to the repo's version (`.nvmrc` = 24 / `engines.node >= 22.13`), with the pnpm store cached.
- [ ] `pnpm install --frozen-lockfile` runs first; a lockfile drift fails the job.
- [ ] Gate step: `pnpm typecheck` runs and a type error fails the job.
- [ ] Gate step: `pnpm test` runs (the fast Vitest unit run) and a failing test fails the job.
- [ ] Gate step: the hermetic e2e suite runs **explicitly** via `pnpm test:e2e` (it is excluded from `pnpm test` by `vite.config.ts`), and a failing spec fails the job. No real browser is needed — it spawns `web/server.mjs` against the fake CDP host (`test/e2e/`), node env only.
- [ ] Gate step: `pnpm build` runs as a build smoke (the Vite renderer bundle compiles); a build error fails the job.
- [ ] Gate step: `node --check web/server.mjs` runs and a syntax/parse error fails the job (this is the exact class of failure that 502'd prod).
- [ ] Biome runs **scoped to files changed in the PR only** — not pristine `pnpm check`. A pristine `pnpm check` is NOT in the workflow, because a clean checkout already fails on pre-existing Biome errors in untouched files (MEMORY: pnpm-check-spike-failure). The scoped Biome step lints+formats only the PR's changed files and fails on a real issue introduced by the PR.
- [ ] Failure of any gate step blocks the PR (the job exits non-zero; no step swallows its exit code).
- [ ] No secrets are required to run CI (the gate is hermetic — no remote browser, no deploy keys).
- [ ] `package.json` scripts are reused as-is where they exist (`typecheck`, `test`, `test:e2e`, `build`); any new convenience script added for the scoped-Biome step is documented in CLAUDE.md's Testing block.

## Test plan

### Layer 1 — Pure logic (TDD)

n/a — this task is CI YAML and (at most) a thin `package.json` script. No pure-logic
module under `src/lib/` or a root CJS module is touched, so there is nothing to drive
test-first.

### Layer 2 — Manual smoke (CDP/IPC)

No main-process / IPC / CDP code is touched, but the gate itself is verified on real
CI (HITL — needs GitHub Actions, not a local-only check):

- [ ] Push a branch and open a PR → the `ci.yml` job runs and all gate steps appear (typecheck, test, e2e, build, node --check, scoped Biome).
- [ ] All gates pass on a clean PR → the job is green.
- [ ] Confirm the e2e step actually ran the hermetic suite (`pnpm test:e2e` output shows `test/e2e/*.e2e.test.ts` specs, server spawned), not silently skipped.
- [ ] Confirm Biome is **changed-files-scoped**: a PR touching only a clean file passes Biome even though a pristine `pnpm check` on the same checkout fails (verify by intentionally not touching the known-dirty files).
- [ ] Introduce a deliberate type error on a throwaway branch → the typecheck gate goes red and the PR is blocked; revert.
- [ ] Introduce a deliberate parse error in `web/server.mjs` on a throwaway branch → the `node --check` gate goes red; revert.
- [ ] Merge the clean PR to `main` → the `push` trigger fires and the same gates run green on main.

### Layer 3 — Visual review

n/a — no renderer UI is touched.

## Design notes

This is a CI-config-only change; there is no application contract for a consumer to
break. The workflow composes existing `package.json` scripts so the gate stays in
lockstep with local commands.

- **`.github/workflows/ci.yml`** — new file, the only workflow created here. One job
  (`gate`) on `ubuntu-latest`: checkout (fetch enough history for changed-file
  diffing against the PR base), pnpm + Node setup with store cache,
  `pnpm install --frozen-lockfile`, then the gate steps in order — `pnpm typecheck`,
  `pnpm test`, `pnpm test:e2e`, `pnpm build`, `node --check web/server.mjs`, and the
  scoped-Biome step. Each step is independent and surfaces its own non-zero exit.
- **Scoped Biome:** compute the PR's changed file list (diff against the base ref;
  on a `push` to main, diff against the previous commit) and run
  `biome check` / `biome ci` over just that list, or run Biome's own
  `--changed --since=<base>` mode. The intent is the hard rule: never run pristine
  `pnpm check` in CI — it fails on pre-existing dirt in untouched files. If a small
  helper is cleaner than inlining the diff in YAML, add a `package.json` script
  (e.g. `check:changed`) and document it; keep it minimal.
- **Hermetic e2e:** `pnpm test:e2e` runs `vitest --config vitest.e2e.config.ts`,
  which spawns the real `web/server.mjs` against `test/e2e/fake-cdp-host.mjs` and
  asserts over HTTP/SSE/WS in a node env — no browser download, no remote CDP host.
  This is the "hermetic e2e" the locked scope means. The Playwright browser suite
  (`test:e2e:browser`) is **not** in this gate (needs a browser install; out of
  scope).
- **Node pin:** match the repo (`.nvmrc` = 24, `engines.node >= 22.13`). Use the
  pinned version so CI and the prod target (Node-24 web server) agree.
- **New ADR needed?** no — adopting GitHub Actions for a hermetic CI gate is a
  tooling choice, not an architectural decision, and the existing scope lock already
  records it. The release-please adoption decision rides with task 038, not here.

## Out of scope

- **release-please pipeline / `engines.node` bump** — owned by the downstream
  `release-please-pipeline-and-engines-bump` task (038) this one blocks. No release
  workflow, no version automation here.
- **Signed/notarized macOS Electron release** — stays in task 003, marked DEFERRED
  v0.2. Electron is best-effort for v0.1.0 (keeps building, no formal ship); CI does
  not run `electron-builder` or any packaging/signing step.
- **Claude-bot workflows** (`@claude` bot, PR auto-review, daily docs-revise) and
  their token-usage scripts — also stay in task 003, DEFERRED v0.2.
- **Playwright browser e2e** (`pnpm test:e2e:browser`) — needs a browser install and
  a heavier runner; not part of the hermetic gate.
- **Branch protection rules / required-status-check settings** on GitHub — a repo
  setting, not a tracked file; note it in the PR but don't claim it as a code change.
- **Pristine `pnpm check` in CI** — deliberately excluded; the scoped-Biome step
  replaces it (see Design notes).

## Definition of Done

All must be true before status → done.

- [ ] Layer 1 tests written and green (if pure logic was touched) — n/a here
- [ ] Layer 2 smoke checklist completed on real CI (PR opened, all gates run + pass; scoped-Biome and a deliberate-failure check confirmed) — HITL
- [ ] Layer 3 screenshots captured and committed (if UI touched) — n/a
- [ ] `pnpm check` clean (Biome — lint + format) on the files this task touches (the YAML + any `package.json` script edit), not pristine
- [ ] `pnpm typecheck` clean
- [ ] `pnpm test` green
- [ ] `pnpm dev` boots cleanly and the changed surface works end-to-end — n/a (no runtime app surface changed); confirm instead that the workflow YAML is valid and `pnpm web` still boots
- [ ] CLAUDE.md Testing block updated if a new `package.json` script (e.g. `check:changed`) was added
- [ ] ADR written if an architectural decision was made — n/a
- [ ] No commented-out code, no `console.log` debris, no AI attribution
- [ ] Task closed: status → done, file moved to `docs/tasks/done/`, tNNN in commit

## Notes

This is the inner-ring gate that makes every later v0.1.0 task safer to land — once
it's green, the release-please pipeline (038) can require it before cutting a release
PR. Keep the workflow lean: reuse the existing scripts, don't invent parallel test
commands, and resist adding the Electron packaging smoke "while you're here" — that
belongs to deferred task 003. The single subtle requirement is the scoped Biome step:
a pristine `pnpm check` will go red on a clean checkout (MEMORY:
pnpm-check-spike-failure), so the gate MUST diff against the PR base and lint only
changed files, or the gate is useless on day one. Verify the e2e step locally first
(`pnpm test:e2e`) so a YAML typo isn't the thing that makes CI red.

---

_When task status flips to `done`, move this file to `done/`._
