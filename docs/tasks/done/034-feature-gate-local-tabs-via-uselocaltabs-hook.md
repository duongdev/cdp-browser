# 034 — structural feature-gate: useLocalTabs() hook + caps.ts + feature-gates.md

- **Status:** done
- **Mode:** AFK
- **Estimate:** 1d
- **Ring:** inner
- **Slice:** 0-scaffolding
- **Depends on:** none
- **Blocks:** none

## Goal

Local tabs are an Electron-only feature, but on the web PWA the renderer still *runs* the local-tab machinery and only hides the UI at a couple of leaf seams — so the feature visibly leaks (the user already noticed). This task makes the gate **structural**: a new pure `caps.ts` owns the capability flags (`getCaps`/`WebCaps`) split out of the transport file, and a new `useLocalTabs()` hook reads `caps.localTabs` at the single data source and returns **empty state + no-op handlers** when local tabs are off. After this ships, `app.tsx` physically cannot drive local-tab logic on web — the sidebar receives `[]` local tabs, `LocalWebviews` never mounts, and the new-tab kind toggle + Cmd+T / Cmd+Shift+T route to CDP only. It is one guarded surface for the one feature that has the bug, plus a `feature-gates.md` convention recording the gate-at-the-data-source rule. It doubles as a down-payment on the `app.tsx` god-component debt by relocating the local-tab state cluster into a named hook.

## Why now

This is decision 3 in the locked v0.1.0 scope, and it merges three synthesis items into one structural task (`gate-local-tabs-on-web` + `decouple-getcaps-from-transport` + `extract-use-local-tabs-hook`). The web PWA is the v0.1.0 release surface; shipping a release where an Electron-only feature half-works on web fails the daily-driver bar. Today `getCaps()` lives transport-coupled inside `cdp-web-transport.ts`, so capability detection and the web transport are entangled; and caps are read at only ~2 of ~6 local-tab seams (`sidebar.tsx` LOCAL TABS section + `settings-dialog.tsx`), while `app.tsx` never reads caps at all — it always holds `localTabs` state, always mounts `LocalWebviews`, and always wires the kind toggle. Gating at the leaves is whack-a-mole; gating at the data source makes the leak structurally impossible and is the inner-ring scaffolding the iPad shell work builds on.

## Acceptance criteria

- [ ] `getCaps()` and the `WebCaps` type live in a new pure `src/lib/caps.ts` — no transport imports, no DOM/Electron coupling beyond the existing `window.webCaps` read; `cdp-web-transport.ts` re-exports or imports from `caps.ts` so its public surface is unchanged.
- [ ] A `useLocalTabs()` hook exists at `src/hooks/use-local-tabs.ts` and is the **single data source** for local-tab state and handlers in `app.tsx` (the `localTabs` list, active local id, kind toggle, open/close/switch/reorder/pin handlers, and the `LocalApi` ref).
- [ ] When `caps.localTabs` is `false`, the hook returns an **empty local-tab list** and **no-op handlers** — calling any handler is inert (no state change, no IPC, no `window.local` call).
- [ ] Every local-tab seam in `app.tsx` reads from `useLocalTabs()` (not from inline `useState`/`useRef`): the sidebar gets `[]` local tabs on web, `LocalWebviews` does not mount on web, and the new-tab kind toggle + Cmd+T / Cmd+Shift+T resolve to CDP only on web.
- [ ] On the Electron build (`caps.localTabs === true`) local tabs behave exactly as before — open, close, switch, pin, reorder, reopen, persistence/restore all unchanged (byte-for-byte behavior, just relocated into the hook).
- [ ] `src/hooks/use-local-tabs.ts` contains the local-tab effect/state cluster previously inline in `app.tsx`; no orphaned local-tab `useState`/`useRef`/handlers remain in `app.tsx`.
- [ ] `docs/conventions/feature-gates.md` exists and states the rule: gate Electron-only features at the data source (a capability-reading hook returning empty/no-op), not at leaf render sites. It is **scoped to local-tabs** as the one example — explicitly not a generic gating framework.
- [ ] `pnpm check`, `pnpm typecheck`, and `pnpm test` are green; the web build shows zero local-tab UI and the Electron build is unchanged.

## Test plan

Per [../conventions/tdd.md](../conventions/tdd.md). `caps.ts` is pure → strict TDD (Layer 1). The hook's gating contract (empty/no-op when off) is testable with a fake caps reader → Layer 1. The wiring into `app.tsx` is renderer-only, so there is no CDP/IPC smoke layer; correctness is confirmed visually on both builds (Layer 3).

### Layer 1 — Pure logic (TDD)

- [ ] `caps.ts` `getCaps` — returns the injected/`window.webCaps` caps when present (web: `localTabs: false`); returns the Electron default (`localTabs: true`, `extensions: true`) when `window.webCaps` is absent.
- [ ] `useLocalTabs` (gating contract, via a fake caps reader / `renderHook`) — with `caps.localTabs === false`, the returned list is empty and every handler is a no-op: invoking open/close/switch/pin produces no state change and no injected-effect call.
- [ ] `useLocalTabs` — with `caps.localTabs === true`, the hook exposes the real list and handlers (open appends a `LocalTab`, close removes it, switch sets the active local id) — exercised against injected fakes so no real `window.local`/DOM is needed.
- [ ] `useLocalTabs` — the no-op handlers are stable references (don't churn each render) so consumers in `app.tsx` don't re-subscribe.

### Layer 2 — Manual smoke (CDP/IPC)

n/a — renderer-only. No `main.js`/`server.mjs`/IPC code changes; `window.local` is only *called less often* on web, not modified.

### Layer 3 — Visual review

- [ ] **Web build** (`pnpm web`, or `pnpm dev` with `window.webCaps` stub set → `localTabs: false`): the sidebar has **no LOCAL TABS section**, the new-tab dialog has **no local/CDP kind toggle**, Cmd+T / Cmd+Shift+T open/reopen CDP tabs only, and `LocalWebviews` is not in the DOM. Screenshot the sidebar + new-tab dialog.
- [ ] **Electron build** (`pnpm dev`): local tabs unchanged — open a local tab, switch to it, pin it, close it, Cmd+Shift+T reopens it; the LOCAL TABS section and kind toggle render as before. Screenshot the sidebar with a local tab present.
- [ ] Desktop-web verification via Chrome DevTools is acceptable for the web-build screenshots; the iPad-physical PWA pass belongs to t018 and is **not** required here.

## Design notes

The change is structural, not behavioral: local-tab behavior on Electron is identical; on web it becomes inert at the source instead of hidden at the leaves.

- **Contracts changed:** `getCaps` / `WebCaps` move from `cdp-web-transport.ts` to a new pure `caps.ts`; the transport file imports/re-exports them so existing importers (`sidebar.tsx`, `settings-dialog.tsx`) keep working with no import churn required (update imports to `@/lib/caps` if cleaner — either is acceptable as long as the surface is unchanged). The `WebCaps` shape (`{ web, localTabs, extensions }`) is unchanged.
- **New modules:**
  - `src/lib/caps.ts` — pure capability reader. Owns `WebCaps` + `getCaps`. Transport-agnostic so caps no longer ride on the web-transport module's lifetime.
  - `src/hooks/use-local-tabs.ts` — the data-source gate. Reads `caps.localTabs`; when `false` returns a frozen empty/no-op surface, when `true` returns the live local-tab state + handlers (the cluster relocated out of `app.tsx`). The gate lives in the hook body so a single early branch decides the whole feature.
- **New ADR needed?** no. The gate-at-the-data-source rule is recorded as a **convention** (`docs/conventions/feature-gates.md`), not an ADR — it is a coding-practice rule scoped to one feature, not an architectural decision with alternatives weighed. References ADR-0005 (local-tabs-base-window) and ADR-0006 (web-proxy) for the Electron/web split, and the existing `caps.web`/`caps.localTabs` usage.

```ts
// the gated hook surface — empty list + no-op handlers when caps.localTabs is false
interface UseLocalTabs {
  localTabs: LocalTab[]            // [] on web
  activeLocalId: string | null     // null on web
  activeKind: ActiveKind           // pinned to 'cdp' on web
  openLocalTab(url: string): void  // no-op on web
  closeLocalTab(id: string): void  // no-op on web
  switchToLocal(id: string): void  // no-op on web
  // …reorder, pin, the LocalApi ref, etc. — all inert on web
}

declare function useLocalTabs(): UseLocalTabs
```

The hook owns the local-tab state cluster (`localTabs`, `localActiveId`, `activeKind`, the `localTabsRef`/`activeKindRef`/`localApiRef` refs, and the open/close/switch/reorder/pin handlers) currently inline in `app.tsx`. On web the early `!caps.localTabs` branch returns the frozen empty surface, so the data never exists for `app.tsx` to act on — `LocalWebviews` is rendered conditionally on a truthy `localTabs.length`/`caps.localTabs`, the kind toggle is omitted, and the Cmd+T / Cmd+Shift+T routing falls through to the CDP path because there are no local entries to reopen.

## Out of scope

- A generic feature-gate **framework** — `feature-gates.md` and `useLocalTabs()` are scoped to local-tabs only (the one feature with the leak). Do not build a `useCapability(name)` abstraction.
- Gating extensions (`caps.extensions`) as its own structural hook — extensions ride along inside the local session; this task only guarantees the existing `caps.extensions` leaf checks aren't broken by the caps move. A dedicated extensions gate, if ever needed, is a separate task.
- The broader `app.tsx` effect-cluster extraction / god-component refactor — deferred to v0.2 (this task only relocates the local-tab cluster, taking the down-payment).
- The `main.js` connector adoption (task 032) and any `server.mjs`/`window.local` changes — untouched; `window.local` is still a no-op stub on web as before.
- Touch input, latency, find-bar, copy-url, and other v0.1.0 items — separate tasks.

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
- [ ] Task closed: status → done, file moved to `docs/tasks/done/`, t034 in commit

## Notes

- Ground truth before starting: `getCaps`/`WebCaps`/`DEFAULT_CAPS` live in `cdp-web-transport.ts` (~lines 27–46, plus `window.webCaps = DEFAULT_CAPS` near line 1016). Caps are read only in `sidebar.tsx` (LOCAL TABS section) and `settings-dialog.tsx` today; `app.tsx` reads no caps and always drives local tabs. That asymmetry is exactly the leak this task closes.
- The load-bearing invariant: the gate lives **in the hook**, not at every consumer. If a future seam forgets to check caps, it still gets `[]`/no-ops because the data source itself is empty on web. That is the whole point of gating at the data source.
- Keep the no-op handlers as stable references (e.g. module-level frozen no-ops or memoized) so `app.tsx` callbacks/effects don't churn between renders.
- Update `src/lib/CLAUDE.md` (add `caps.ts`) and the root `CLAUDE.md` File Structure + the `src/hooks/` mention (add `use-local-tabs.ts`) in the same commit per docs-discipline.
- When relocating the local-tab cluster, move — don't rewrite — the existing handlers so Electron behavior stays byte-for-byte; the only new code is the `!caps.localTabs` empty/no-op branch.

---

_When task status flips to `done`, move this file to `done/`._
