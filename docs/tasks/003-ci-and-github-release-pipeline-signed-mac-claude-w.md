# 003 — CI and GitHub release pipeline (signed mac + Claude workflows)

- **Status:** ready — RESCOPED for v0.1.0 (2026-05-30): the v0.1.0 CI gate -> t037, version reset/SHA/api-version -> t035/t036, release-please pipeline -> t038. The signed/notarized macOS Electron release + the three Claude-bot workflows below are DEFERRED to v0.2 (Electron is best-effort, unsigned; the v0.1.0 release surface is the web PWA only).
- **Mode:** HITL
- **Estimate:** 1.5d
- **Depends on:** none
- **Blocks:** none (auto-update + Windows port tasks depend on this)

## v0.1.0 rescope note

v0.1.0 ships the **web PWA only**. Electron stays best-effort — keeps building via `scripts/install-local.sh`, unsigned, no formal ship.

CI gate for v0.1.0 is carved out to **t037** (ci-pr-push-gate): typecheck + `pnpm test` + hermetic e2e + build smoke + `node --check web/server.mjs`; Biome scoped to changed files.

Versioning for v0.1.0 is **release-please (t038)**, with the `package.json` 2.0.0->0.1.0 reset + git-SHA / build-version injection + `/api/version` in **t035/t036**. This SUPERSEDES this task's old manual-`workflow_dispatch` + semantic-versioning notes for v0.1.0.

REMAINING here, DEFERRED to v0.2: the signed + notarized macOS electron-builder publish workflow (CSC_LINK/notarization, all-arch artifacts, latest-mac.yml, electron-updater) and the three Claude-bot workflows (@claude bot, claude-review, daily docs-revise) + usage scripts.

## Goal (DEFERRED v0.2)

Set up GitHub Actions CI (check+typecheck+test+packaging smoke) and a signed/notarized macOS release workflow (workflow_dispatch, all 3 arches: arm64+x64+universal, dmg+zip artifacts). Wire up electron-builder publish to GitHub releases, upload latest-mac.yml for future auto-update, and port the upstream workflows' three Claude workflows (@claude bot, PR review, daily docs-revise) with custom-provider→OAuth fallback.

## Why now

Current state: no CI, manual unsigned builds. Needed to ship public OSS releases on macOS (Gatekeeper blocks unsigned downloads). Unblocks public user adoption, testing on CI, and Claude-native LLM automation (review, @claude bot, doc audits).

## Acceptance criteria

- [ ] `.github/workflows/ci.yml` — PR + main push trigger: Biome check, typecheck, test, electron-builder --dir (packaging smoke) all green
- [ ] `.github/workflows/release.yml` — workflow_dispatch with semver bump input → CI bumps package.json + commits to main + creates git tag vX.Y.Z → electron-builder --publish always → GH release with all 3 mac artifacts (arm64 dmg+zip, x64 dmg+zip, universal dmg+zip) + latest-mac.yml
- [ ] `electron-builder` config updated: `publish: github` set, asar allowlist verified against `inject/`, `notifications.js`, `theme-emulation.js`
- [ ] App passes code-signing: `codesign -vvv` verifies Developer ID signature on packaged .app; notarization passes (confirmed via `xcrun stapler validate`)
- [ ] `.github/workflows/claude.yml` — @claude comment trigger, custom-provider→OAuth fallback, token usage reporting
- [ ] `.github/workflows/claude-review.yml` — auto code-review on PRs (from the upstream workflows), custom provider pattern
- [ ] `.github/workflows/docs-revise.yml` — daily scheduled doc audit, single rolling PR on `docs-revise/auto`, load the upstream workflows' prompt rules
- [ ] `.github/scripts/claude-usage-quota.sh` + `.github/scripts/claude-usage-report.sh` ported from the upstream workflows
- [ ] `.releaserc.cjs` (semantic-release config) — if using semantic versioning; else confirm manual semver bumping suffices (grill chose manual workflow_dispatch)
- [ ] One test dispatch to a draft release with a canary version (e.g., `999.0.0-test`) confirms build pipeline succeeds and signing/notarization succeed
- [ ] Documentation: CLAUDE.md updated with CI + release procedures, secrets required, architecture

## Test plan

### Layer 1 — Pure logic (TDD)

N/a — this task only touches CI/GitHub Actions YAML and config (no app code changes to test).

### Layer 2 — Manual smoke (build + release)

- [ ] Commit trivial change to non-main branch, push → CI triggers on PR, all gates pass (check, typecheck, test, packaging smoke)
- [ ] Merge PR to main → CI triggers on main push, all gates pass
- [ ] On main, bump package.json version to `999.0.0-test`, commit locally (do not push)
- [ ] Trigger workflow_dispatch release workflow with bump input `999.0.0-test` → CI commits version bump, tags, builds
- [ ] Verify GH release created as draft with all 6 artifacts (arm64 dmg+zip, x64 dmg+zip, universal dmg+zip) + latest-mac.yml
- [ ] Download universal dmg, verify code signature: `codesign -vvv ./CDP\ Browser.app` succeeds
- [ ] Verify stapler validation: `xcrun stapler validate ./CDP\ Browser.app` confirms notarization
- [ ] Revert test commit + tag (`git tag -d v999.0.0-test && git reset --hard HEAD~1`)
- [ ] @mention @claude in a PR comment → bot responds (confirms OAuth/custom-provider auth works)
- [ ] Trigger docs-revise workflow manually via GH UI → bot creates/updates `docs-revise/auto` PR (confirms docs-revise setup)

### Layer 3 — Visual review

N/a — no renderer changes.

## Design notes

**Signing model:**
- Developer ID Application cert from Apple dev account exported as base64 `.p12` → GH secret `CSC_LINK`, password → `CSC_KEY_PASSWORD`
- electron-builder reads env vars, signs binaries during build, uploads to Apple notarization service via notarytool (App Store Connect API key)
- App Store Connect API key (.p8) → GH secrets `APPLE_API_KEY` (file content), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` (issuer UUID)

**Release trigger:**
- workflow_dispatch with version input (explicit semver, no bump-level abbr for clarity)
- CI: `npm version` (or equivalent pnpm) to bump package.json, commit `chore(release): vX.Y.Z`, push to main, tag vX.Y.Z
- electron-builder `--publish always` uploads artifacts + latest-mac.yml to release, no manual `gh release` needed

**Artifact strategy:**
- All 3 mac arches (arm64, x64, universal) as separate dmg+zip pairs → redundant but covers all user cases
- universal2 is also shipped for future auto-update simplicity (electron-updater prefers universal on mac)

**Claude workflows:**
- Custom provider config (for an alternate LLM provider) with OAuth fallback (matching the upstream workflows pattern)
- PR review, @claude bot, docs-revise all live; token usage tracked + reported

**New modules/contracts:** None — configuration only.

**ADR needed?** No — existing decisions in 0001, 0002, 0003 (single-page, adaptive viewport, notifications).

## Out of scope

- **Windows port** — deferred to separate task (requires chrome + hotkey layer port + win signing cert)
- **Auto-update in app** — separate task (electron-updater setup, update-check UI, staged rollout logic)
- **Publish UI in app** — happens with auto-update task
- **Semantic-release version automation** — using manual workflow_dispatch + CI version bumping; semantic-release not wired (grill decision: too complex for desktop app, manual semver sufficient)

## Definition of Done

All must be true before status → done.

- [ ] Layer 2 smoke checklist (manual release test) completed, draft release created + signed/notarized
- [ ] `.github/workflows/` contains ci.yml, release.yml, claude.yml, claude-review.yml, docs-revise.yml (or adapted names)
- [ ] `.github/scripts/` contains claude-usage-quota.sh, claude-usage-report.sh ported from the upstream workflows
- [ ] `electron-builder` config in package.json: publish+asar allowlist updated
- [ ] CI + release secrets added to repo settings (CSC_LINK, CSC_KEY_PASSWORD, APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER, CLAUDE_CODE_OAUTH_TOKEN or custom-provider equivalent)
- [ ] Test dispatch to draft release succeeds; artifacts signed + notarized verified
- [ ] CLAUDE.md updated: CI/release procedures, required secrets, troubleshooting
- [ ] `.github/docs-revise-prompt.md` + `.github/REVIEW.md` ported from the upstream workflows (if using claude review)
- [ ] One clean commit with message `chore(ci): add github actions + signed release pipeline (t003)` (no test/draft versions shipped to prod)
- [ ] Task closed: status → done, file moved to `docs/tasks/done/`, tNNN in commit

## Notes

**Grill decisions logged** (from /grill-me grilling session 2026-05-24):
- Audience: public OSS users (need signing + notarization)
- Signing: Developer ID cert (CSC_LINK/CSC_KEY_PASSWORD) + notarization via App Store Connect API key
- Mac artifacts: all 3 (arm64+x64+universal, dmg+zip each)
- Windows: **deferred** to separate task (app has macOS-specific chrome/hotkeys, requires port)
- CI scope: check + typecheck + test + packaging smoke (electron-builder --dir unsigned)
- Release trigger: workflow_dispatch, CI bumps package.json + commits + tags (main unprotected ✓)
- Auto-update: electron-updater (separate task; this task wires publish:github + latest-mac.yml only)
- Claude workflows: all three (bot, review, docs-revise), custom-provider→OAuth fallback

**Key references:**
- Upstream workflows prompt + review docs: .github/docs-revise-prompt.md, REVIEW.md
- Upstream workflows token tracking: .github/scripts/claude-usage-*.sh
- cdp-browser constraints: CLAUDE.md (architecture, no Windows support yet, asar allowlist fragile)

**Subtasks (execution phases, but one atomic commit):**
1. Set up CI gate (check+typecheck+test+packaging-smoke)
2. Set up release.yml (workflow_dispatch, CI bumps, electron-builder --publish)
3. Port Claude workflows (bot, review, docs-revise) + scripts
4. Update docs + create test release draft
5. Verify signing/notarization + close

---

_When task status flips to `done`, move this file to `done/`._
