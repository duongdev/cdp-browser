# 050 — show version + build SHA in settings About row

- **Status:** done
- **Mode:** AFK
- **Estimate:** 0.5d
- **Ring:** inner
- **Slice:** 2-ipad-shell
- **Depends on:** build-version-injection-and-api-version-endpoint
- **Blocks:** none

## Goal

Add a read-only **About** row to the settings drawer that shows the installed
build's version and short git SHA. After this task, opening Settings on the iPad
PWA answers "what build am I on" at a glance — the version (e.g. `0.1.0`) and a
short SHA (e.g. `a1b2c3d`) sit in their own card near the bottom of the drawer.
The values come from the build-time defines injected by the
`build-version-injection-and-api-version-endpoint` task (`__APP_VERSION__` +
`__GIT_SHA__`); on the web build, when a define is unavailable the row falls back
to fetching `GET /api/version`. Display only — nothing is editable, no action
buttons.

## Why now

This is part of the v0.1.0 inner-ring gate (Slice 2 — iPad shell). The web PWA is
the release surface and the daily driver on iPad, where there is no terminal, no
DevTools, no "About" menu, and no obvious way to confirm which build is running.
After a `per-build SW cache + update-available reload prompt` lands (t044), the
operator needs a way to verify the reload actually moved them to the new build —
the About row is that verification surface. It also makes bug reports answerable:
"what build am I on" must have an in-app answer before the iPad workday
verification gate (t018) signs off. It can't ship until the version/SHA defines
exist, hence the dependency on `build-version-injection-and-api-version-endpoint`.

## Acceptance criteria

- [ ] Settings drawer shows an **About** row displaying the build version and a short git SHA.
- [ ] The version reads from the injected `__APP_VERSION__` define; the SHA reads from `__GIT_SHA__`, truncated to a short form (first 7 chars).
- [ ] On the web build, if either define is missing/empty at runtime, the row fetches `GET /api/version` and renders the values from the response; a failed fetch degrades to a readable placeholder (e.g. `unknown`), never a crash or blank.
- [ ] The row is **read-only** — no inputs, switches, or buttons; selecting the text is allowed but nothing is editable.
- [ ] The row matches the existing settings-card visual language (same `Card`/label styling already used for Appearance, Viewport, Connection, etc.) — it does not introduce a new visual pattern.
- [ ] No Electron-only or web-only branch leaks into the other surface: in Electron the defines are present so no fetch fires; in web the fetch fallback path exists. Neither surface logs an error in the normal case.
- [ ] `pnpm typecheck`, `pnpm check`, and `pnpm test` stay clean.

## Test plan

### Layer 1 — Pure logic (TDD)

n/a — display only. The lone transform (truncate a SHA to 7 chars, fall back to a
placeholder string) is trivial inline formatting, not a domain module worth a pure
unit. If the fallback grows beyond a one-liner during implementation, extract a tiny
pure `formatBuildInfo(version, sha)` helper and TDD it; otherwise keep it inline.

### Layer 2 — Manual smoke (CDP/IPC)

n/a — no main-process, IPC, or CDP/WS code is touched. The only network call is a
plain `GET /api/version` against the web proxy (already provided by the dependency
task), exercised in Layer 3.

### Layer 3 — Visual review

- [ ] Screenshots captured via Chrome MCP against `pnpm dev` (Electron) and `pnpm web` (browser).
- [ ] Open Settings; the About row renders version + short SHA in both surfaces.
- [ ] Web build with defines present: values render from the defines, no `/api/version` request fires (confirm in the network panel).
- [ ] Web build with defines stubbed empty: the row fetches `/api/version` and renders the returned values; with the endpoint forced to fail, the row shows the `unknown` placeholder and the drawer still renders cleanly (no thrown error in console).
- [ ] **HITL (iPad-physical):** in the installed iPad PWA, the About row is legible and tappable-to-select within the safe-area; verify on a real device during the t018 workday pass.

## Design notes

The version/SHA values are produced upstream by
`build-version-injection-and-api-version-endpoint` as Vite `define` constants
(`__APP_VERSION__`, `__GIT_SHA__`) and, for the web surface, mirrored by a
`GET /api/version` endpoint on the proxy. This task only **consumes** them — it
adds no new contract and owns no build wiring.

- **Settings drawer (`src/components/settings-dialog.tsx`)** — add one more `Card` (reuse the existing `Card`/label primitives already in this file; do not invent a new container) titled `About`, placed near the bottom of the grouped cards (after the existing groups, lowest-priority info). It renders a label/value pair for version and a label/value pair for the short SHA. The SHA is shortened to 7 chars for display.
- **Define access + fallback** — read `__APP_VERSION__` / `__GIT_SHA__` directly. On the web build only, if a value is absent (define not injected), fetch `GET /api/version` once on drawer open (or on first render of the card) and render from it; a rejected/failed fetch yields a stable `unknown` placeholder. Electron always has the defines, so the fetch branch never runs there. Guard the web-only fetch behind the existing `window.webCaps`/web-surface detection already used in this component rather than re-detecting the environment.
- **Contracts changed:** none — no exported type or module interface changes. The `__APP_VERSION__`/`__GIT_SHA__` global declarations are introduced by the dependency task; this task assumes they exist.
- **New modules:** none (unless the fallback formatting is extracted to a tiny pure helper per Layer 1 — only if it earns it).
- **New ADR needed?** no — this is a display addition, not an architectural decision. The version-surfacing decision (build-time injection + `/api/version`) is recorded with `build-version-injection-and-api-version-endpoint`, not here.

## Out of scope

- The build-time injection of `__APP_VERSION__`/`__GIT_SHA__` and the `GET /api/version` endpoint — owned by `build-version-injection-and-api-version-endpoint` (the dependency).
- The `per-build SW cache + update-available reload prompt` (t044) — a separate task; this row only *displays* the version, it does not detect or prompt for updates.
- Any Electron-specific version surfacing beyond reading the shared defines (e.g. an Electron native About panel, `app.getVersion()` wiring, auto-update) — Electron is best-effort for v0.1.0; Electron version surfacing + `electron-auto-update` are deferred to v0.2+.
- A full diagnostics/about panel (build date, transport mode, connected host, etc.) — out of scope; this is just version + SHA.
- Copy-to-clipboard on the version string — not requested; if wanted later it's a follow-up.

## Definition of Done

All must be true before status → done.

- [ ] Layer 1 tests written and green (if pure logic was touched) — n/a unless a fallback helper is extracted
- [ ] Layer 2 smoke checklist completed with a live Remote Browser (if main.js/IPC touched) — n/a
- [ ] Layer 3 screenshots captured and committed (if UI touched)
- [ ] `pnpm check` clean (Biome — lint + format)
- [ ] `pnpm typecheck` clean
- [ ] `pnpm test` green
- [ ] `pnpm dev` boots cleanly and the changed surface works end-to-end
- [ ] CLAUDE.md updated for any modified module (note the new About row under `settings-dialog.tsx` if the File Structure description warrants it)
- [ ] ADR written if an architectural decision was made — n/a
- [ ] No commented-out code, no `console.log` debris, no AI attribution
- [ ] Task closed: status → done, file moved to `docs/tasks/done/`, tNNN in commit

## Notes

Keep it boring: one card, two label/value rows, read-only. The whole point is a
trustworthy answer to "what build am I on" — so make sure the fallback path can
never render a confusing blank. Prefer a visible `unknown` over an empty string
when both the define and the fetch fail. Don't gold-plate it into a diagnostics
panel; that temptation belongs to a future task if it ever earns its keep.

---

_When task status flips to `done`, move this file to `done/`._
