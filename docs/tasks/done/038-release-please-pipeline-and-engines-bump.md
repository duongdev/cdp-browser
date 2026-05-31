# 038 — release-please v4 PR-gated pipeline + engines.node bump

- **Status:** done
- **Mode:** HITL
- **Estimate:** 1d
- **Ring:** inner
- **Slice:** 0-scaffolding
- **Depends on:** reset-version-to-0-1-0 (t035), ci-pr-push-gate (t037)
- **Blocks:** none

## Goal

Give the project a deliberate, human-reviewed release mechanism. After this task,
merging conventional commits to `main` makes release-please open and maintain a
standing "release PR" that accumulates the changelog and the next version; merging
*that* PR cuts the release — it bumps `package.json`, updates `CHANGELOG.md`, tags
`vX.Y.Z`, and publishes a GitHub Release. No version is ever cut by hand, and no
commit body is ever required: the breaking-change `!` suffix on a conventional
commit type (e.g. `feat(api)!: …`) is the only signal that drives a major bump.
The same task bumps `engines.node` from `>=22.13` to `>=22.14` so the declared
engine matches the runtime toolchain.

## Why now

The v0.1.0 release surface is the **web PWA** (the daily-driver iPad PWA), and
v0.1.0 is the inner-ring gate. We need a repeatable way to *cut* that release and
every release after it. The strict house commit convention — semantic title only,
no body, no AI attribution (see [../conventions/git.md](../conventions/git.md)) —
rules out the tools that lean on verbose commit bodies (changesets, default
semantic-release): release-please reads the conventional-commit *titles* we already
write and enforce via commitlint, and gates the cut behind a reviewable PR. It is
the last scaffolding task in slice 0: t035 set the real starting version `0.1.0`
and seeded `.release-please-manifest.json`, and t037 built the CI gate that becomes
this pipeline's required check. With those landed, this task closes the release-tooling
loop so the v0.1.0 cut (and v0.1.1 fast-follow) can ship through a PR rather than a
manual tag.

## Acceptance criteria

- [ ] `.github/workflows/release-please.yml` exists, triggers on push to `main`, and runs `googleapis/release-please-action@v4` with `release-type: node` (or points at the config file below). It needs `contents: write` + `pull-requests: write` permissions and uses the default `GITHUB_TOKEN`.
- [ ] `release-please-config.json` exists at the repo root, declaring a single root package (`"."`) with `"release-type": "node"`, and pairs with the `.release-please-manifest.json` seeded by t035 (`{ ".": "0.1.0" }`).
- [ ] On a push to `main` with at least one releasable conventional commit, release-please opens (or updates) a single standing release PR titled `chore(main): release 0.1.0` (or the next computed version), containing the generated `CHANGELOG.md` and the bumped `package.json` version.
- [ ] Merging that release PR creates the git tag `vX.Y.Z` and a GitHub Release with the changelog body; no separate manual `gh release` step is needed.
- [ ] The breaking-change `!` suffix is honored **with no commit body**: a commit titled `feat(x)!: …` (or `fix(x)!: …`) computes a **major** bump, a `feat:` a minor, a `fix:` a patch. Verified against a dry-run / draft release PR (see Layer 2), not assumed.
- [ ] The release PR's required status check is the CI gate from t037 (the PR must be green before it can merge); branch protection / required-check wiring references t037's workflow name.
- [ ] `package.json` `engines.node` is `">=22.14"` (was `">=22.13"`). No other `package.json` field changes here (version line is owned by release-please / t035; build allowlist, scripts, deps untouched).
- [ ] No AI attribution anywhere in the workflow, config, or any commit the pipeline produces (release-please's own commit/PR titles are `chore(...)`-style and carry no AI references).
- [ ] `pnpm typecheck`, `pnpm check`, and `pnpm test` stay clean.

## Test plan

### Layer 1 — Pure logic (TDD)

n/a — this task only touches CI/GitHub Actions YAML, release-please config JSON, and
one `package.json` field. No pure-logic module is added or changed, so there is
nothing to drive test-first.

### Layer 2 — Manual smoke (release pipeline)

HITL — needs a GitHub push + PR; no live Remote Browser required (this is repo/CI
behavior, not app runtime). The goal is to confirm the release PR opens correctly
and the `!` suffix bumps as expected *before* trusting it for the real v0.1.0 cut.

- [ ] Push a branch with the workflow + config, open a PR → t037's CI gate runs and is the required check; merge to `main`.
- [ ] On the next `main` push containing a releasable commit, release-please opens a standing release PR titled `chore(main): release 0.1.0` with a `CHANGELOG.md` reflecting the commits since `0.1.0` and a `package.json` bumped to the computed version. Inspect the PR — do **not** merge the canary.
- [ ] Confirm the `!` marker: push a throwaway `feat(test)!: canary breaking change` commit (no body) to a scratch branch merged to `main`, and verify release-please's release PR proposes a **major** bump (the diff/PR title shows the next major). Then revert the canary commit so the real cut starts from `0.1.0` (`git revert` the canary; release-please recomputes downward on the next run).
- [ ] Confirm a plain `fix:` commit yields a **patch** bump and a `feat:` yields a **minor** bump in the proposed PR (one of each is enough; can be observed from the same canary pass).
- [ ] Merge the (clean, non-canary) release PR once → verify a `vX.Y.Z` tag and a GitHub Release with the changelog body are created automatically.
- [ ] Confirm the release PR cannot merge while t037's CI check is red (flip a deliberate failure on a scratch PR to verify the required-check gate, then restore).

### Layer 3 — Visual review

n/a — no renderer UI is touched. Nothing renders in the app; the only "UI" is the
GitHub release PR, covered by Layer 2 inspection.

## Design notes

Configuration only — no application code, no seams, no contract a consumer can break.
The pipeline reads commit *titles* and the seeded manifest; it does not call into any
app module.

- **`.github/workflows/release-please.yml`** — new workflow, `on: push: branches: [main]`. One job running `googleapis/release-please-action@v4` with `release-type: node`, `permissions: { contents: write, pull-requests: write }`, default `GITHUB_TOKEN`. This is the only piece that *opens/maintains* the release PR and cuts the tag/Release on merge. CI exists only after t037; this workflow assumes that gate is the required check on the release PR.
- **`release-please-config.json`** — new root config. Single root package keyed `"."` with `"release-type": "node"`, paired to `.release-please-manifest.json` (seeded by t035, not re-created here). Keeping config + manifest explicit (rather than action inputs) makes the release-type and package layout reviewable in one file and lets a future monorepo add packages without rewriting the workflow (see [../adr/0008-defer-monorepo-shared-cjs-core.md](../adr/0008-defer-monorepo-shared-cjs-core.md) — root CJS today, packages later).
- **`package.json`** — single field change: `engines.node` `">=22.13"` → `">=22.14"`. The `version` line is **not** touched here (t035 set it to `0.1.0`; release-please owns it thereafter). Build `files` allowlist, scripts, and deps are untouched.
- **Breaking-change signal:** the `!` suffix on the conventional type is the contract for a major bump, deliberately replacing commit-body `BREAKING CHANGE:` footers we don't write (the house convention is title-only, no body). commitlint already enforces conventional titles, so release-please has clean input.
- **New ADR needed?** no — the release-please adoption decision (release-please v4, `release-type: node`, PR-gated, `!`-suffix breaking changes, no commit bodies, PWA-only release surface for v0.1.0) is the locked v0.1.0 plan and is recorded in [../tasks/README.md](README.md) (v0.1.0 milestone) and the rescoped t003 notes. If a reviewer wants it as a standalone record, scaffold a short ADR — but it is a process choice, not an architectural one, so this task does not require it.

## Out of scope

- Resetting `package.json` to `0.1.0` and seeding `.release-please-manifest.json` — owned by **t035** (this task only adds the config + workflow + engines bump and assumes the manifest already reads `{ ".": "0.1.0" }`).
- The CI gate itself (typecheck + test + hermetic e2e + build smoke + `node --check` server, Biome scoped to changed files) — owned by **t037**; this task only references it as the release PR's required check.
- Build-time version/SHA injection and the `/api/version` endpoint — owned by `build-version-injection-and-api-version-endpoint` (t036).
- Surfacing the version in the settings About row — owned by t050.
- Signed/notarized macOS Electron release, `electron-auto-update`, and the Claude-bot / PR-review / docs-revise workflows — all **deferred to v0.2** (see t003; Electron is best-effort for v0.1.0 with no formal ship).
- Branch-protection rules in repo settings (a GitHub UI/admin action) — noted as a HITL setup step in Layer 2, not a file in this repo.

## Definition of Done

All must be true before status → done.

- [ ] Layer 1 tests written and green (if pure logic was touched) — n/a here (config only)
- [ ] Layer 2 smoke checklist completed (release PR opens with the correct `0.1.0` changelog; `!` suffix verified to bump major with no commit body) — HITL, no live Remote Browser required
- [ ] Layer 3 screenshots captured and committed (if UI touched) — n/a
- [ ] `pnpm check` clean (Biome — lint + format)
- [ ] `pnpm typecheck` clean
- [ ] `pnpm test` green
- [ ] `pnpm dev` boots cleanly and the changed surface works end-to-end
- [ ] CLAUDE.md updated for any modified module — note the release-please pipeline (PR-gated, `release-type: node`, `!`-suffix breaking changes) under the project's release/tooling description if it lacks one
- [ ] ADR written if an architectural decision was made (expected: none — it's a process choice, recorded in tasks/README.md)
- [ ] No commented-out code, no `console.log` debris, no AI attribution
- [ ] Task closed: status → done, file moved to `docs/tasks/done/`, t038 in commit

## Notes

- Verify the `!`-suffix behavior against current release-please v4 docs before relying on it (Context7) — the action has changed its config schema across majors (`release-please-config.json` + manifest is the v4 shape; older versions used inline action inputs). The locked decision is v4 + `release-type: node`; confirm the config keys against the version actually pinned in the workflow.
- The standing release PR is *idempotent*: release-please updates the same PR as new commits land on `main` rather than opening a new one each time. Reviewers should expect one open `chore(main): release …` PR, not a stream.
- `release-type: node` is what reads `package.json` as the version source of truth and writes `CHANGELOG.md` — confirm it picks up the t035-seeded `0.1.0` and does not try to recompute from the old `2.0.0` (it won't, if the manifest is correct; the manifest is the override).
- Dependencies are referenced by both id and task number where known (t035 `reset-version-to-0-1-0`, t037 `ci-pr-push-gate`) because the slice-0 release-tooling tasks were numbered together; if a number shifts, the id is the stable handle.

---

_When task status flips to `done`, move this file to `done/`._
