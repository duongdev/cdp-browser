# ADR-0008: Defer pnpm monorepo; extract shared core as repo-root CJS modules

- **Status:** Accepted
- **Date:** 2026-05-29

## Context

`main.js` (the Electron backend) and `web/server.mjs` (the web-build proxy) re-implement the same CDP logic — settings load/save + migrations, `/json` endpoint URLs, the Notification Side-Channel state machine, and the Remote Page connect choreography. The web build already consumes the shared CommonJS modules `cdp-endpoints.js` and `settings-store.js`; `main.js` does not, so the two backends drift silently (a Teams selector fix, a new setting, or a CDP route change must be patched twice). This duplication is the root of the "architecture is heavy, hard to maintain" friction.

A `pnpm` workspace monorepo (`packages/core`, `packages/renderer`, `packages/electron`, `packages/web`) was considered as a way to enforce a shared-core boundary at the package level. The actual daily-driver surface is the web build installed as a PWA on iPad, not the Electron app.

## Decision

Extract shared logic into **backend-agnostic plain CommonJS modules at the repo root** — continuing the existing pattern (`notifications.js`, `cdp-endpoints.js`, `settings-store.js`) — consumed by `main.js` (via `require`) and `web/server.mjs` (via ESM default `import`). Each module takes its effects through **dependency injection** (a WebSocket factory, a `/json` fetcher, a persist callback, an effect sink), keeping it Electron-agnostic and unit-testable.

Defer the `pnpm` workspace monorepo as a **separate, later decision**.

## Consequences

**Easier:**
- Deduplication lands now with zero build/packaging changes — no electron-builder, Vite, Biome, husky, or CI restructure.
- Each extracted module is unit-testable with fakes; both backends inherit one source of truth.
- Fully reversible; low risk to the shipping app.

**Harder / unchanged:**
- No tooling-enforced boundary — a future duplication could regrow. Mitigated by convention plus tests on the shared cores.
- If a monorepo is ever adopted, it still begins by extracting exactly these modules. Extraction is a prerequisite either way, so nothing is lost by deferring; the door stays open.

## Alternatives

- **Monorepo now** — rejected. A large, risky restructure (electron-builder asar packaging vs `node-linker=hoisted` workspace symlinks, the `build.files` allowlist, plus Vite/Biome/husky/vitest/CI) *before* any dedup ships. The renderer `dist/` is a single artifact both shells consume, so splitting it into a package is cosmetic. Extraction is step 1 regardless of the end-state.
- **Monorepo as committed end-goal (build toward it)** — rejected for now. No second app shell exists to justify a policed boundary. Revisit if a third surface (mobile, CLI) appears, at which point these repo-root modules promote to `packages/core` near-verbatim.
