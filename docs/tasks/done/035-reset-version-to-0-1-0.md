# 035 — reset package.json 2.0.0 → 0.1.0 + release-please manifest

- **Status:** done
- **Mode:** AFK
- **Estimate:** 0.5d
- **Ring:** inner
- **Slice:** 0-scaffolding
- **Depends on:** none
- **Blocks:** build-version-injection-and-api-version-endpoint, release-please-pipeline-and-engines-bump

## Goal

Set the project's single source of truth for "what version is this" to the real
first cut, `0.1.0`, and seed the release-please manifest so automated releases
start counting from there. Right now `package.json` says `2.0.0` — a stale
placeholder that was never a real release. After this task, `package.json`
declares `0.1.0`, a `.release-please-manifest.json` file pins `{ ".": "0.1.0" }`,
and the one stray `v2.0.0`/`v2.1.0` mention in the git convention doc is corrected
to match. This is config and version metadata only — no application code logic
changes.

## Why now

v0.1.0 is the WEB PWA release (the daily-driver iPad surface). Every
release/version-surfacing item in the v0.1.0 scope keys off this single number:
the build-time version injection + `/api/version` endpoint, and the release-please
pipeline both read it as the starting point. release-please v4 (`release-type:
node`) needs a manifest seeded to the true starting version, or its first release
PR will compute the next version from `2.0.0` and ship something absurd. This task
is the smallest possible unblock for the whole release slice — it must land before
the two tasks it blocks can do anything correct.

## Acceptance criteria

- [ ] `package.json` `version` field is `"0.1.0"` (was `"2.0.0"`).
- [ ] `.release-please-manifest.json` exists at the repo root with exactly `{ ".": "0.1.0" }`.
- [ ] No remaining reference to `2.0.0` as the project's current version anywhere in tracked files (search `2.0.0` and confirm each hit is either gone, corrected, or unrelated — e.g. a third-party version string in a lockfile is fine; the project's own version is not).
- [ ] `docs/conventions/git.md` "Tags and releases" section no longer cites `v2.0.0`/`v2.1.0` as the example tag scheme — its example reflects the real `v0.1.0` starting line (e.g. `v0.1.0`, `v0.2.0`).
- [ ] No application code logic is touched — the diff is limited to `package.json` (version line only), the new manifest file, and the doc fix.
- [ ] `pnpm typecheck`, `pnpm check`, and `pnpm test` stay clean.

## Test plan

### Layer 1 — Pure logic (TDD)

n/a — config and version metadata only; no pure logic module is touched, so there
is nothing to drive test-first.

### Layer 2 — Manual smoke (CDP/IPC)

n/a — no main-process, IPC, or CDP/WS code is touched. The version change has no
runtime behavior in v0.1.0 (the build-time injection that surfaces it is a separate
blocked task). Confirm only that `pnpm web` still boots cleanly after the bump (the
server reads `package.json` as a module; a malformed JSON edit would break it).

### Layer 3 — Visual review

n/a — no renderer UI is touched. The version is not yet rendered anywhere; that
surfacing lands in the downstream `build-version-injection` task.

## Design notes

This is a metadata-only change behind no seams. There is no contract for a consumer
to break — the version is read by tooling, not application code, until the
downstream injection task wires it in.

- **`package.json`** — the `"version": "2.0.0"` line becomes `"version": "0.1.0"`. Nothing else in the file changes (name, build allowlist, scripts, deps all untouched).
- **`.release-please-manifest.json`** — new root file, the canonical "where are we" pointer release-please v4 reads on every run. Content is exactly `{ ".": "0.1.0" }` (single root package, no monorepo paths). Its companion config (`release-please-config.json` with `release-type: node`) is **not** created here — that lands with the pipeline task this one blocks; the manifest is seeded first so the pipeline task starts from a correct number.
- **`docs/conventions/git.md`** — the "Tags and releases" section currently uses `v2.0.0`/`v2.1.0` as its tag-scheme example. Correct it to the real starting line so the doc doesn't contradict the actual first release. Surgical: only the stale example, nothing else in that section's wording.
- **New ADR needed?** no — this is a value correction, not an architectural decision. The release-please adoption decision (release-type, PR-gating, `!`-suffix breaking changes) is recorded with the pipeline task, not here.

## Out of scope

- Creating `release-please-config.json` or any GitHub Actions workflow — that is the `release-please-pipeline-and-engines-bump` task this one blocks.
- The `engines.node` bump — also owned by the pipeline task.
- Build-time version injection into the bundle / a `/api/version` endpoint / surfacing the version in the UI — owned by `build-version-injection-and-api-version-endpoint`.
- Any Electron release/version-surfacing wiring — Electron is best-effort for v0.1.0 (no formal ship); `electron-auto-update` and Electron version surfacing are deferred to v0.2+.
- Touching the existing release task 003 (rescoped separately) or rewriting its content.

## Definition of Done

All must be true before status → done.

- [ ] Layer 1 tests written and green (if pure logic was touched) — n/a here
- [ ] Layer 2 smoke checklist completed with a live Remote Browser (if main.js/IPC touched) — n/a; only confirm `pnpm web` boots
- [ ] Layer 3 screenshots captured and committed (if UI touched) — n/a
- [ ] `pnpm check` clean (Biome — lint + format)
- [ ] `pnpm typecheck` clean
- [ ] `pnpm test` green
- [ ] `pnpm dev` boots cleanly and the changed surface works end-to-end
- [ ] CLAUDE.md updated for any modified module — n/a (no module changed; version isn't documented as a behavior)
- [ ] ADR written if an architectural decision was made — n/a
- [ ] No commented-out code, no `console.log` debris, no AI attribution
- [ ] Task closed: status → done, file moved to `docs/tasks/done/`, tNNN in commit

## Notes

Keep the diff tiny and obvious — a reviewer should see three things: the version
line flip, the new one-line manifest, and the doc example fix. Resist the urge to
also add `release-please-config.json` "while you're here"; the pipeline task owns it
and wants it landing with its workflow so the two are reviewed together. Sanity-check
the manifest is valid JSON (`node --check` won't validate `.json`; a quick
`node -e "require('./.release-please-manifest.json')"` confirms it parses) so the
blocked pipeline task doesn't trip on a typo.

---

_When task status flips to `done`, move this file to `done/`._
