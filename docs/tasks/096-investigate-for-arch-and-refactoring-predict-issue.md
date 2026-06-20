# 096 — Arch + refactoring sweep: verified fixes from the predict-issues / improve-architecture investigation

- **Status:** in-progress
- **Mode:** HITL
- **Estimate:** multi-session (~2–3d; ships as one PR with internal commit boundaries by area)
- **Depends on:** none
- **Blocks:** none

## Goal

A predictive-health + architecture-deepening investigation (20 predicted issues
+ 7 deepening candidates) was run and then **adversarially verified against the
real code**. Verification refuted 17 of 20 predicted issues and 4 of 7 deepening
candidates as already-mitigated — the codebase already has the caps, watchdogs,
error handlers, and seams the finders assumed were missing. This task lands the
**genuinely-actionable remainder**: one real consolidation (settings ui-state),
one testability extraction (web-transport factories), one real bug (Electron
`onSwipe` leak), and a batch of small hardening fixes. After it ships, the
ui-state load/write path has a single owner, the WS channel + reconnect driver
have isolated tests, the swipe-listener leak is gone, and every "optional"
robustness gap the verifiers flagged is closed — with the full evidence trail
recorded so the same proposals aren't re-litigated.

## Why now

The investigation already did the expensive part (find + verify). The findings
are small, independent, and decay if left unrecorded — the next arch review
would re-run the same analysis and re-propose the same refuted refactors. Batch
the cleanup while the evidence is fresh, and record the "why not a reducer"
reasoning in ADR-0015 so it stops recurring.

## Acceptance criteria

Grouped by area. Each is checkable true/false.

### A — Settings ui-state single owner (was A3, Med) — SCOPED DOWN

Investigation finding sharpened during implementation: `app.tsx` and
`settings-dialog.tsx` own **mostly-disjoint** settings (app.tsx: sidebar / theme
/ adaptiveViewport / mutes / etc.; settings-dialog: virtualPointer / webPush /
scroll). The only cross-file overlap is `slackExcludes`, and app.tsx reads it
**on-demand** (not cached) while the dialog reloads it on every open — so the
"divergence" self-heals and there is no live cache-staleness bug. A full
`useSettings` hook absorbing all 15 settings would **de-localize** settings from
their UI (the opposite of the locality win) for no correctness gain — exactly the
over-engineering ADR-0015 warns against. The real, bounded defect the verifier
named was **the dual load**.

- [x] **Dual load removed** — `settings-dialog.tsx` called `getUiState()` **twice**
      in its open effect (virtual-pointer/scroll, then web push/excludes); merged
      into **one** load, web fields gated inside it. Behavior preserved.
- [x] Writes still partial-merge server-side (unchanged); no save-queue / offline
      machinery added.
- [ ] Full single-owner `useSettings` hook + the ~28-prop `app→Toolbar→dialog`
      drill-through — **DEFERRED** (see Notes / spillover task). De-localizing
      risk + needs Layer-3 visual review unavailable in this AFK run.
- [ ] Visual review of the settings dialog (all cards persist correctly) —
      **HITL pending**.

### B — Web-transport factory extraction + tests (was A5, Med)

- [x] `createWsChannel`, `createInputChannel`, `createReconnectDriver` are
      lifted out of `cdp-web-transport.ts` into their own files, each with
      injectable deps preserved.
- [x] Unit tests cover the WS channel (new, 8) and the reconnect driver (existing,
      colocated). (Correction: the reconnect driver already had a test — the real
      zero-coverage gap was the WS channel.) Input channel +1 (fallback contract).
- [x] `createWebCdp` remains the assembler; the already-pure seams
      (`downlink-dispatcher`, `uplink-router`, `crypto-context`,
      `transport-selector`, `reconnect-backoff`, `input-coalesce`) are **not**
      re-extracted. (Assembler is 970L — the verifier's "~200L" was the rejected
      proposal's aspiration; the corrected scope was extract-the-3-factories only.)
- [x] `cdp-web-transport.ts` line count drops materially: 1419 → 970.

### C — onSwipe listener leak (was P6, S, Electron-only)

- [x] `preload.js` `onSwipe` returns an unsubscribe
      (`removeListener` of the named wrapper); web stub returns a no-op unsubscribe;
      `CdpBridge` type updated to `=> () => void`.
- [x] The `app.tsx` swipe effect returns that unsubscribe as cleanup.
- [ ] After repeated reconnects, a single swipe fires `goBack`/`goForward`
      exactly once (manual Electron smoke). **HITL pending** — needs the Electron app.

### D — Notification optimistic-write revert (was A2 real defect, S)

- [x] The 6 dual-write handlers (`markThreadRead`, `handleMarkAllRead`,
      `handleClearNotifications`, `handleClearThread`, `handleMuteChannel`,
      `handleToggleRead`) route through one optimistic-mutate helper
      (`optimisticNotif`) that applies the local patch and **reverts to the
      pre-patch snapshot if the POST rejects**.
- [x] No reducer / event-bus introduced (ADR-0015).

### E — Hardening nits (all S)

- [x] **P15** — settings `writeFileSync` is wrapped in try-catch + `console.error`
      in both `main.js` and `web/server.mjs` (mirrors the existing `savePushSubs`).
      `core/settings-store.js` delegates to the injected persist, so guarding both
      injection sites is the fix (no store change).
- [x] **P7** — `sendPushToAll` recomputes `unreadExcluding` from a fresh
      `notificationCenter.list()` at each send (not the pre-await snapshot), so an
      in-flight push can't stamp a stale per-device badge.
- [x] **P18** — `createClosedStack` caps entries (shift oldest beyond ~50).
      Done: `CLOSED_STACK_CAP = 50`, FIFO drop; `closed-tabs.test.ts` covers it.
- [x] **P4** — `cdpCall` (side-channel) races a timeout and rejects pending on
      ws close/error, so a stalled socket frees its ~2 promises. Done:
      `CDP_CALL_TIMEOUT_MS=10_000`, drop rejects+clears pending; test covers close.
- [x] **A1** — an `applyNextActive` helper dedupes the `nextActive`
      switch tail shared by `closeTab` and `closeTabs`.
- [x] **P11** — `page.find()` has a `.catch` (no unhandled rejection on socket drop).
- [x] **P19** — the command-palette `action.run()` is wrapped in try-catch with a
      failure toast (`sonner`).
- [x] **P2** — the paint-ack watchdog is adaptive (derived from measured
      RTT/paint latency) instead of a fixed 1000 ms, so a legitimately-slow device
      can't trip it early. Done: pure `core/paint-ack-pacer.js` (EWMA, floor 1s,
      cap 5s, ×3); server records markSent→ack latency and arms the timer from it;
      6 unit tests.
- [x] **P3** — side-channel `reconcile` also closes+reattaches a socket stuck in
      CONNECTING/CLOSING (not OPEN), covering the hung-connect edge. Done:
      `SIDECHANNEL_STALE_MS=15_000` stale reap; 3 tests (reap/no-reap-fresh/no-reap-open).
- [x] **A6** — the two per-workspace sweep triggers (`onCreds` + `onSlackSignal`,
      which both call `sweepWorkspace`) share one debounced `core/sweep-scheduler.js`
      (leading + trailing, per workspace key) — not an event-driven orchestrator.
      The 15s all-workspaces `runOnce` backstop stays separate (no per-key). The
      verifier's "4 trigger sites" overcounted — only these two double-fire.
- [x] **A7** — `readerEntry` is folded into the phone-view union
      (`{ view: "reader", entry }`), removing the parallel state. Visual review
      of the phone shell remains **HITL pending**.

### Docs

- [ ] ADR-0015 committed (already drafted).
- [ ] CLAUDE.md updated for every module whose contract changed
      (`use-settings`, the new transport-factory files, `closed-tabs` cap,
      `cdp-web-transport` shrink).

## Test plan

### Layer 1 — Pure logic (TDD)

- [x] `closed-tabs.ts` `createClosedStack` — push past the cap drops the oldest;
      pop order unchanged (P18). ✓ green
- [x] `core/sweep-scheduler.js` `createSweepScheduler` — leading-edge run, trailing
      coalesce of same-key triggers within the window, independent keys, post-window
      re-fire, `stop()` cancels (A6). ✓ green
- [ ] the optimistic-mutate helper — applies patch on success; reverts to the
      prior list on a rejected POST (A2/D).
- [x] `createReconnectDriver` — backoff schedule + WS re-climb fires the
      injected connect at the expected steps (B). ✓ green (pre-existing test
      colocated to `web-reconnect-driver.test.ts`).
- [x] `createWsChannel` — frame/ack/input routing over an injected socket; paint-
      ack defer path (B). ✓ green (new `web-ws-channel.test.ts`, 8 cases; was 0).
- [x] paint-ack watchdog timeout derivation — given an RTT/paint sample, the
      watchdog window is ≥ a floor and tracks the sample (P2). ✓ green

### Layer 2 — Manual smoke (CDP/IPC)

Against a live Remote Browser:

- [ ] **P6** — swipe back/forward in the Electron app; reconnect (switch tabs)
      several times; one swipe still navigates exactly once.
- [ ] **P15** — make `settings.json` unwritable; change a setting; app logs the
      error and stays up (no crash, no silent data path).
- [ ] **P4** — kill a side-channel socket mid cred-extraction; server keeps
      sweeping other workspaces; no hung promise accrues.
- [ ] **P3** — force a side-channel into CONNECTING and leave the target live;
      next reconcile re-attaches it.
- [ ] **P7** — fire a push while marking a thread read; the per-device badge
      count is correct on the next push.

### Layer 3 — Visual review

- [ ] Screenshots via Chrome MCP against `pnpm dev` of the settings dialog
      (all cards), driven through the new `useSettings` hook — loading, empty,
      error, populated.
- [ ] Phone-shell Conversation Reader still opens/back-navigates after the
      `readerEntry`→union fold (A7).
- [ ] Command palette shows the failure toast when an action throws (P19).

## Design notes

Behavioral contracts, not file paths. Full file:line evidence is in **Notes**.

- **Contracts changed:**
  - **Settings ui-state** — today two owners (`app.tsx` + `settings-dialog.tsx`)
    each load and write ui-state; after, a single `useSettings` hook is the only
    loader/writer. Partial-merge write semantics unchanged. No new persistence
    machinery.
  - **`window.cdp.onSwipe`** — `(cb) => void` → `(cb) => () => void` (returns an
    unsubscribe). Web stub stays a no-op but now returns a no-op unsubscribe to
    satisfy the same contract.
  - **Notification mutation handlers** — fire-and-forget optimistic writes →
    optimistic-with-revert (the server's returned list is the source of truth on
    success; the prior list is restored on failure).
  - **`createClosedStack`** — unbounded → bounded (cap ~50, FIFO drop).
  - **side-channel `cdpCall`** — never-times-out → races a timeout; pending
    rejected on socket close.
  - **paint-ack watchdog** — fixed `PAINT_ACK_WATCHDOG_MS = 1000` → adaptive
    window derived from RTT/paint latency (with a floor).
- **New modules:**
  - `src/hooks/use-settings.ts` — single ui-state load + write owner (A3).
  - `src/lib/web-ws-channel.ts`, `src/lib/web-input-channel.ts`,
    `src/lib/web-reconnect-driver.ts` — the three factories lifted from
    `cdp-web-transport.ts`, now unit-tested (A5). (Final names TBD; keep
    kebab-case.)
  - a small `scheduleSweep` debounce helper (A6) and an optimistic-mutate
    helper (A2) — likely co-located with their consumers, not standalone seams.
- **New ADR needed?** Yes — **ADR-0015** (drafted): prefer thin handlers + small
  helpers over reducer/event-bus indirection where orchestration is already
  concentrated. It records *why* A1/A2/A4/A6 were down-scoped, not deepened.

## Out of scope

- **The reducer/event-bus refactors themselves** — A1 Tab Lifecycle
  Orchestrator, A2 Notification Store reducer, A4 Input Intent Builder, A6 Slack
  Sweep event stream as proposed. Verified as already-deep; see ADR-0015. Only
  the small real defects they exposed are in scope.
- **The settings save-queue / offline-write machinery** (A3 as originally
  proposed) — no observed lost-write or offline failure; would be speculative.
- **The 13 refuted predictions** — verified already-safe, **not touched**:
  P1 (200-entry `ingest` cap), P5 (per-socket pending Map, GC'd on close),
  P8 (`appliedMetrics`-on-OPEN-socket guard), P9 (per-sweep `groupId` derivation),
  P10 (endpoint dedup + 404/410 prune), P12 (`refreshTabs` guards `result.error`),
  P13 (once-per-foreground gate; also a TODO stub), P14 (dedup precedes push in
  one sync tick), P16 (ResizeObserver native on target), P17 (`clearTimeout` in
  cleanup exists), P20 (`innerWidth` fallback exists). Listed here so a future
  reader doesn't re-investigate them.

## Notes

Free-form scratchpad — the investigation receipts.

### Implementation summary (AFK session)

All 15 flagged items implemented across 9 commits on `refactor/t096-arch-refactor-sweep`:

| Commit | Items |
|---|---|
| `52c0ece` | investigation + ADR-0015 + P18 (closed-tab cap) + A6 (sweep debounce) |
| `efcbe25` | P4 + P3 (side-channel timeout + hung-socket reap) |
| `33094a4` | P15 + P7 (settings persist guard + per-send push badge) |
| `32b31d5` | P2 (adaptive paint-ack watchdog) |
| `8220609` | A5 (extract ws/input/reconnect channels + ws-channel tests) |
| `dab5bae` | P6 + P11 + P19 (swipe unsubscribe + find/palette guards) |
| `f6ad10e` | A1 + A7 + A2 (close-tail dedupe + reader union + notif revert) |
| `46075ef` | A3 (settings dialog dual-load merge; full hook → t097) |

**Automated gates all green:** `pnpm typecheck`, `pnpm test` (936), `pnpm test:e2e`
(43), `pnpm build`, `node --check` on all 3 backends, `pnpm check:changed` (0 errors;
pre-existing `noConsole` warnings only). New tests added: closed-tabs cap, sweep-scheduler,
paint-ack-pacer, sidechain reap/timeout, ws-channel, input-channel.

**HITL-pending (could not run AFK — needs the iPad / live Remote Browser / Electron app):**
- Layer-2 smoke: P6 (swipe×reconnect), P15 (unwritable settings), P4 (stalled cred socket),
  P3 (hung side-channel reap), P7 (push-while-marking badge).
- Layer-3 visual: A7 (phone shell reader nav), A3 (settings cards persist), P19 (palette toast).
- App-boot check (main.js / preload.js touched by P6, P15).

This is why the task stays **in-progress** — do the smoke + visual passes, then close.

### Method

`/predict-issues` + `/improve-codebase-architecture` ran as two Explore agents
(20 + 7 findings). Every finding was then adversarially verified by a per-finding
agent (skeptical, default-refute) that read the actual code. Verdicts below cite
**real** file:line refs (the finders' original line numbers were often
speculative). The verification refuted the majority — the codebase was in much
better shape than the raw predictions implied.

### Verdict table — predicted issues

| ID | Verdict | Real defect (verified) | Where |
|---|---|---|---|
| P1 | refuted | `ingest` slices to `DEFAULT_CAP=200` on every write, all paths | `core/notifications.js:70-74`, `notifications-sidechain.js:34` |
| P2 | **in (P2)** | watchdog already re-acks remote; but window is fixed 1000 ms → slow device trips early | `web/server.mjs:391-440`, `core/frame-ack-gate.js:21-46` |
| P3 | **in (P3)** | `drop` fires on close+error & reconcile reaps; residual hung-CONNECTING socket not reaped | `core/notifications-sidechain.js:229-234,276-285` |
| P4 | **in (P4)** | `cdpCall` has no timeout; fire-and-forget so can't block, but leaks ~2 promises/dead socket | `core/notifications-sidechain.js:198-213,239-260` |
| P5 | refuted | pending Map is per-socket (≤2), freed on close via closure GC | `core/notifications-sidechain.js:197-228` |
| P6 | **confirmed (C)** | `onSwipe` no unsubscribe + effect no cleanup → dup back/fwd per swipe after reconnect; Electron-only | `src/app.tsx:1234-1239`, `preload.js:26`, `cdp-web-transport.ts:1285` |
| P7 | **in (E)** | `sendPushToAll` computes `unreadExcluding` from a pre-await `list` snapshot → one-count-stale badge | `web/server.mjs:173-219` |
| P8 | refuted | `appliedMetrics` stamped only on OPEN-socket send; reconnect rebaselines | `main.js:288-326,382-398`, `adaptive-viewport.ts:86-99` |
| P9 | refuted | `gid` derived per-sweep from cred's `enterpriseId\|\|teamId`; no stale map in keying | `core/slack-creds.js:62-64`, `slack-sweep-runner.js:137` |
| P10 | refuted | subscribe dedups by endpoint; dead pruned on 404/410 | `web/server.mjs:1050-1053,224-225`, `core/push-subscriptions.js:6-15` |
| P11 | **in (E)** | `setQuery` zeroes total before await (no stale total); but `.then` has no `.catch` → unhandled rejection | `src/components/find-bar.tsx:46-56`, `find-bar.ts:39-45` |
| P12 | refuted | `refreshTabs` guards `result.error` before `reconcile`; no tab loss | `src/app.tsx:517-538`, `main.js:209-217` |
| P13 | refuted | once-per-foreground `revalidatedThisForeground` flag; call site is a TODO stub | `src/lib/push-revalidate.ts:4-29`, `app.tsx:256-266` |
| P14 | refuted | dedup precedes push in one sync tick; stable id makes re-sweeps idempotent | `core/notifications-sidechain.js:347-354`, `notifications.js:70-75` |
| P15 | **confirmed (E)** | settings `writeFileSync` unguarded in both backends (inconsistent w/ wrapped `savePushSubs`) | `main.js:76`, `web/server.mjs:123`, `core/settings-store.js:66` |
| P16 | refuted | ResizeObserver native on iOS 16.4+/Electron Chromium; no polyfill needed | `src/components/viewport.tsx:542` |
| P17 | refuted | `clearTimeout(timer)` already in effect cleanup + keyup/blur reset | `src/app.tsx:982-1003` |
| P18 | **confirmed (E)** | `createClosedStack` uncapped (per-session ref, tiny objects) | `src/lib/closed-tabs.ts:18-24`, `app.tsx:954,1045` |
| P19 | **in (E)** | palette closes+clears before `run()` (state safe), but `run()` has no try-catch | `src/components/command-palette.tsx:41-45` |
| P20 | refuted | `shellModeFor(window.innerWidth)` initial + `matchMedia` guard | `src/hooks/use-shell-mode.ts:12-22` |

### Verdict table — deepening candidates

| ID | Verdict | Real action (verified) | Where |
|---|---|---|---|
| A1 | refuted→**small (E)** | planner already pure + tested; only a 2-line directive-apply tail duped between close paths | `tab-lifecycle.ts:59-113`, `app.tsx:922-960,1039-1077` |
| A2 | partial→**in (D)** | already one block + shared read model + authoritative server store; real gap = dual-write, no revert | `app.tsx:577-683`, `notifications-view.ts:74` |
| A3 | partial→**in (A)** | real: two ui-state load+write owners; `slackExcludes` ×3 sites; ~28-prop chain. Skip save-queue/offline | `app.tsx:357-456`, `settings-dialog.tsx:373-427`, `toolbar.tsx:443-472` |
| A4 | refuted | `forwardInput`+`InputIntent` already the seam; coords applied once; t084 proved drop-in | `remote-page.ts:82-95,349-404`, `viewport.tsx:519-532` |
| A5 | partial→**in (B)** | hard seams already promoted; 3 DI'd factories left inline + untested (WS channel, reconnect driver = 0 tests) | `cdp-web-transport.ts:408-606,317-399,120-220` |
| A6 | refuted→**small (E)** | runner already owns state machine; 429 in `slack-api.js`; only the 4 trigger sites could share a debounce | `slack-sweep-runner.js:107-318`, `web/server.mjs:544-554,651,773` |
| A7 | refuted→**small (E)** | `phoneView` already a union; ~63 contiguous lines; only `readerEntry` parallel state to fold | `src/app.tsx:188-250` |

---

_When task status flips to `done`, move this file to `done/`._
