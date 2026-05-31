# TDD discipline

Test-driven development for the parts that can be. This codebase has three distinct layers: pure logic that demands TDD, CDP/IPC glue that demands manual verification, and a UI that demands visual review. Each layer has a clear scope and discipline. Mixing the approaches — writing unit tests for CDP plumbing, or skipping TDD for pure state machines — is the failure mode.

## The three layers

```
┌───────────────────────────────────────────────────────────────────┐
│  3. VISUAL REVIEW — UI via Chrome MCP against vite dev            │  human gate
│     Claude Code drives browser; screenshots committed             │
├───────────────────────────────────────────────────────────────────┤
│  2. MANUAL SMOKE — CDP/IPC glue; no fake-CDP harness              │  per-task checklist
│     human verifies behavior with a live Remote Browser            │
├───────────────────────────────────────────────────────────────────┤
│  1. STRICT TDD — pure functions in src/lib/* and core/*.js        │  fast, automated
│     vitest; no external deps; runs in <5 seconds total            │
└───────────────────────────────────────────────────────────────────┘
```

Build every layer that applies. A pure state machine without unit tests is untested. An IPC handler "verified" only by unit tests has never actually communicated with Electron.

---

## Layer 1 — Strict TDD for pure logic

**Scope:** everything in `src/lib/` and `core/` (all pure-logic CommonJS modules). These are pure functions — no I/O, no IPC, no React. They are fully testable in isolation and they *must* be tested this way.

**Tools:** Vitest. All dependencies are either passed in (fake `Transport` for `createRemotePage`) or are pure computations (no mocking needed for math).

**Location:** colocated with source — `foo.ts` ↔ `foo.test.ts`.

**Run:** `pnpm test` — completes in under 5 seconds, no external services.

**The TDD cycle, strictly:**

```
write failing test  →  minimum code to pass  →  refactor with tests green  →  commit
```

No exceptions for pure logic. If a test feels impossible to write, the design is wrong — the function is probably doing I/O or relying on hidden state. Fix the design first.

**Discipline:**

- One concept per `describe` block.
- Each `it` tests one behavior.
- Arrange → Act → Assert clearly separated. Blank lines between sections.
- No setup that exceeds the test it serves. Long setup = test is too coarse.

**Current coverage (as of 2026-05-28):**

| Module | Test file | What's covered |
|---|---|---|
| `remote-page.ts` | `remote-page.test.ts` | navigation, navigateSpa (pushState+popstate + full-nav fallback), Input Forwarding variants, event demux, frame auto-ack |
| `tabs.ts` | `tabs.test.ts` | reconcile order, nextTab/prevTab wrapping, stripTitleBadge |
| `viewport-transform.ts` | `viewport-transform.test.ts` | letterbox math, toRemoteCoords coordinate mapping, edge cases |
| `adaptive-viewport.ts` | `adaptive-viewport.test.ts` | reduce state machine, all transitions, effect generation |
| `notifications-view.ts` | `notifications-view.test.ts` | groupByConversation, dedup, fallback grouping |
| `key-routing.ts` | `key-routing.test.ts` | isOsReservedKey — reserved combos, Option-rewrite safety, non-Cmd pass-through |
| `pins.ts` | `pins.test.ts` | resolvePinLink, pinForTarget, dropDeadLinks |
| `local-tabs.ts` | `local-tabs.test.ts` | sortPinnedFirst ordering, toPersisted/fromPersisted split |
| `closed-tabs.ts` | `closed-tabs.test.ts` | push/pop preserves close order across CDP and local kinds |
| `active-order.ts` | `active-order.test.ts` | touchActive MRU promotion, dropActive removal, mostRecent with open-set filter |
| `cdp-web-transport.ts` | `cdp-web-transport.test.ts` | `collapseMoves` — run collapsing, click/wheel/key ordering |
| `crypto-envelope.ts` | `crypto-envelope.test.ts` | seal/open round-trip, wrong-key rejection |
| `input-coalesce.ts` | `input-coalesce.test.ts` | createBatcher, createHoverGate, createSingleFlight backpressure |
| `notifications.js` | `core/notifications.test.ts` | dedup, cap, OS-toast gating, markUnread, unreadCount, unreadByTarget |
| `theme-emulation.js` | `core/theme-emulation.test.ts` | emulatedMediaParams — sync on/off, dark/light mapping, reset to empty params |
| `cdp-endpoints.js` | `core/cdp-endpoints.test.ts` | /json URL builders |
| `settings-store.js` | `core/settings-store.test.ts` | config/ui-state defaults, pin CRUD + dedup, legacy migration (switchBlur→switchEffect, bookmarks→pins) |
| `line-splitter.js` | `core/line-splitter.test.ts` | NDJSON reassembly — complete lines, partial/split chunks, blank-line keepalives |
| `frame-throttle.js` | `core/frame-throttle.test.ts` | createFrameThrottle rate gate, fresh-frame-wins drop, everyNthFrameFor |
| `frame-ack-gate.js` | `core/frame-ack-gate.test.ts` | one-in-flight gate, watchdog timeout, ack-then-drop ordering |
| `quality-tier.js` | `core/quality-tier.test.ts` | tierToParams, parseTier (garbage→default), all three tier presets |
| `remote-page-connector.js` | `core/remote-page-connector.test.ts` | connect choreography, connectId race-guard, reconnect |
| `notifications-sidechain.js` | `core/notifications-sidechain.test.ts` | createNotificationCenter side-channel lifecycle |
| `touch-gesture.ts` | `touch-gesture.test.ts` | tap/drag/long-press classification, MOVE_THRESHOLD_PX jitter tolerance |
| `find-bar.ts` | `find-bar.test.ts` | reduce transitions, counterLabel, next/prev wrap |
| `hotkey-registry.ts` | `hotkey-registry.test.ts` | buildActions, filterActions, groupForOverlay |
| `reconnect-backoff.ts` | `reconnect-backoff.test.ts` | exponential growth, cap, giveUp after maxAttempts, success resets |
| `caps.ts` | `caps.test.ts` | getCaps with/without webCaps injection, localTabs/extensions flags |
| `quality-tier.ts` | `quality-tier.ts` (renderer) | parseTier, QUALITY_TIERS shape |
| `echo-cursor.ts` | `echo-cursor.test.ts` | down/move/up state, pointForEvent mapping |
| `settings-dismiss.ts` | `settings-dismiss.test.ts` | shouldArmLeaveTimer — coarse guard, outside-container check |
| `sw-cache-name.ts` | `sw-cache-name.test.ts` | cacheNameFor determinism, version+sha variants |
| `latency-metrics.ts` | `latency-metrics.test.ts` | createRttEstimator EWMA, frameAge, clockOffsetFromRtt, singleton |

Every new module under `src/lib/` or `core/` gets a colocated test file from its first commit.

**Example shape:**

```ts
import { describe, it, expect } from "vitest"
import { reconcile } from "./tabs"

describe("reconcile", () => {
  it("preserves existing tab order when remote list changes", () => {
    const order = ["a", "b", "c"]
    const remote = [
      { id: "c", title: "C", url: "https://c.test", type: "page" },
      { id: "a", title: "A", url: "https://a.test", type: "page" },
    ]

    const result = reconcile(order, remote)

    expect(result.map(t => t.id)).toEqual(["a", "c"])
  })
})
```

---

## Layer 2 — Manual smoke for CDP/IPC glue

**Scope:** `main.js` WebSocket handlers, IPC bridges in `preload.js`, CDP API calls, Notification Side-Channel setup, screencast lifecycle, settings persistence.

**Why no fake-CDP harness:** building a synthetic CDP server that accurately simulates a live Remote Browser (screencast flow, concurrent clients, Page events, timing) would be a substantial separate project and would inevitably diverge from real browser behavior. The cost of maintaining it exceeds the value. The IPC layer is thin; the value-bearing logic lives in Layer 1.

**What "manual smoke" means:** each task that touches the main process includes a concrete HITL (human-in-the-loop) verification checklist. Run it before merging. Examples:

- "Connect to a live Edge instance at `localhost:9222`; verify tabs appear within 2 seconds."
- "Switch tabs; verify the Switch Effect applies and clears on the first new frame."
- "Send a Teams message to yourself; verify the notification bell shows the unread badge."
- "Toggle Adaptive Viewport; verify the letterbox disappears and re-appears on toggle."

These checklists live in the task file's **Test plan** section and in the PR description. They are not automated — that is intentional.

**When to escalate a smoke failure:** if a smoke test reliably fails in a reproducible way, that's a signal the behavior can be extracted into a pure function and tested at Layer 1. Do that extraction before re-running smoke.

---

## Layer 3 — Visual review for the renderer

**Scope:** React components in `src/components/`, UI state in `app.tsx`, anything visible to the user.

**Tools:** Chrome MCP driven by Claude Code, against `pnpm dev` (Vite dev server + Electron). Screenshots committed to the PR for async review.

**Discipline:**

- **Mock-first.** Build every new screen or significant component with hardcoded data first. Get visual sign-off on layout, copy, and states before wiring live IPC.
- **Four-state coverage.** Every screen must visibly handle: loading, empty, error, and the normal populated state. Visual review checks all four. See [frontend.md](frontend.md#state-coverage).
- **Screenshots committed.** For any UI-touching PR, capture screenshots via Chrome MCP and commit them to the branch. PR reviewers see the visual state without running the app.
- **Verify the feature works end-to-end** — not just that it renders, but that clicking, keyboard shortcuts, and state transitions all behave as designed.

**When to write a `*.visual.md` checklist:** for any UI area that's complex enough to have multiple states or interactions worth verifying systematically. Store in `docs/visual/` (create as needed). Keep it short — bullet list of what Claude should verify, not pixel coordinates.

---

## Test naming and organization

```
core/
├── notifications.js
└── notifications.test.ts      # layer 1
src/
├── lib/
│   ├── tabs.ts
│   └── tabs.test.ts           # layer 1
├── components/
│   ├── sidebar.tsx
│   └── sidebar.test.tsx       # layer 3 unit (if warranted)
```

Naming:
- Pure logic: `*.test.ts`
- React components: `*.test.tsx` (when unit-testable in isolation; otherwise visual review is sufficient)

---

## Coverage philosophy

- **No coverage thresholds as gates.** Coverage is a signal, not a target. 100% coverage of trivial coordinate math with 0% coverage of the state machine logic is worse than the inverse.
- Every reported bug in a pure module → first action is "write a failing test that reproduces it." Then fix.
- If you can't write a reproducing test, the bug is in the glue layer — document the reproduction steps in the task file and use Layer 2 to verify the fix.

---

## What each layer is NOT for

| Don't use Layer 1 for | Use instead |
|---|---|
| Verifying that `ipcMain.handle` fires correctly | Layer 2 smoke |
| Checking that a WebSocket message triggers a React re-render | Layer 2 + Layer 3 |
| Screenshot baseline diffs | Layer 3 via Chrome MCP |

| Don't use Layer 2 for | Use instead |
|---|---|
| Testing pure coordinate math | Layer 1 unit test |
| Testing Zustand store transitions | Layer 1 unit test |
| Verifying UI layout | Layer 3 visual review |

| Don't use Layer 3 for | Use instead |
|---|---|
| Testing business logic | Layer 1 unit test |
| Verifying IPC message payloads | Layer 2 smoke |

---

_Test discipline is the difference between a project that survives and one that dies. Don't negotiate with yourself on this._

_Last revisited: 2026-05-28_
