# Tasks

Bite-sized work items. Each task is half-day to one-day sized, with explicit acceptance criteria and a test plan. The unit of "what am I working on this morning."

## Lifecycle

```
draft → ready → in-progress → done
```

- **draft** — captured but spec is incomplete; needs more thinking before pickup
- **ready** — spec is complete, AC defined, test plan in place; can be picked up
- **in-progress** — being worked on (only one task in this state at a time)
- **done** — shipped to main **and closed** (see the closure checklist below)

**`draft → ready` gate:** before promoting, ensure every required section in the task file is filled in. Unresolved design questions mean the task stays `draft`. A task at `ready` must be workable without further clarification.

## Naming

```
<NNN>-<short-kebab-name>.md
```

Sequential 3-digit prefix. Examples:

```
001-biome-and-husky-baseline.md
002-zustand-ui-state.md
003-command-palette.md
…
```

## Closure checklist (do not skip)

A task is **not done when the code merges** — it is done when it is closed. Closure rides in the *same commit* as the code; "I'll close it later" is how tasks stay open indefinitely.

The four mutations:

1. Task file header → `**Status:** done`
2. `git mv docs/tasks/NNN-<slug>.md docs/tasks/done/NNN-<slug>.md` — same filename, numbering stays stable. The file's location in `done/` is the canonical "shipped" signal.
3. Branch, commit, and PR carry the `tNNN` task ID (see [conventions/git.md](../conventions/git.md)).
4. Any mid-task deferral is captured as its own task, idea, or risk.

## What goes in a task file

Use [TEMPLATE.md](TEMPLATE.md). Required sections:

- **Goal** — one paragraph, plain language
- **Why now** — what this enables; what task(s) are blocked on this
- **Acceptance criteria** — testable bullet list
- **Test plan** — which of the three testing layers apply; explicit test cases (see [conventions/tdd.md](../conventions/tdd.md))
- **Mode** — `AFK` (agent can complete autonomously) or `HITL` (needs a human decision mid-task, or requires a live Remote Browser for smoke testing)
- **Design notes** — behavioral contracts and interfaces changed, deps added
- **Out of scope** — what we're NOT doing in this task
- **Definition of Done** — the project's quality bar checklist

If you can't fill in a section, the task isn't ready — leave status as **draft**.

## Sizing rule (the one-session cap)

A task must fit in **one Claude Code session at 1M context, including verification and feedback resolution, without compaction.** Roughly half a day of focused work.

**Why so strict:** compaction loses fidelity. The design intent, the test iterations, the feedback already incorporated — all of it gets summarized away. Splitting upfront is much cheaper than rebuilding context after compaction.

**The "too big" smell test:** if you can't list every file you'll touch and every test you'll write in under 60 seconds of thought, the task is too big.

**How to split:**

- A task that scaffolds *and* implements → split into "scaffold" and "implement."
- A task touching multiple independent modules (e.g. `tabs.ts` + `main.js` + `sidebar.tsx`) → split by module boundary.
- A task with a non-trivial Layer 3 visual review → the visual review checklist IS its own task.

**Tracer-bullet check:** a well-scoped task cuts end-to-end through the relevant layers (pure logic → IPC → UI), not a single horizontal layer. "Add a reducer to `adaptive-viewport.ts`" is a horizontal slice with no user-visible outcome. "Wire Adaptive Viewport toggle in Settings + implement reduce + apply in main process" is a vertical slice that can be demoed.

## Anti-patterns

- "Implement [large feature]" — too big. Break into 5+ tasks.
- "Fix things" — vague, no AC. Reject.
- "Refactor X" without a measurable outcome — what does success look like? Add it to AC.
- A task with `Mode: AFK` but unresolved CDP/IPC design questions — those make it HITL. Resolve before promoting to `ready`.
- A task that requires the remote browser to be running, but is marked `AFK` — it's `HITL`.

## v0.1.0 milestone (locked 2026-05-30)

> **Status (2026-05-30): all inner + outer ring tasks shipped and closed** (t033–t060, see `done/`). The only v0.1.0 item left is **t018** — the HITL iPad-workday gate, which must be run on a real iPad before tagging. `t003` (signed-Electron release + Claude bots) and `t032` (connector adoption in `main.js`) are intentionally deferred to v0.2.

The release surface is the **web PWA**; Electron is best-effort (keeps building, no formal ship). Two rings: the **inner** ring is the real gate (must close before tagging v0.1.0); the **outer** ring is fast-follow v0.1.1 (not tag-blocking). Each task carries `Ring:` + `Slice:` header fields; the slices below are the delivery order.

### Slice 0 — scaffolding (inner)

| # | Title | Ring | Summary |
|---|---|---|---|
| 033 | touch-first co-primary input convention + ADR-0009 | inner | Record touch as a co-primary input model (convention + ADR) before the touch tasks land. |
| 034 | structural feature-gate: `useLocalTabs()` hook + `caps.ts` + `feature-gates.md` | inner | Gate local-tabs at the data source so `app.tsx` can't drive local-tab logic on web; pays down god-component debt. |
| 035 | reset `package.json` 2.0.0 → 0.1.0 + release-please manifest | inner | Set the real first-cut version and seed `.release-please-manifest.json`. |
| 036 | inject version + git SHA into build; `GET /api/version` | inner | Stamp build version/SHA and surface it over a web endpoint. |
| 037 | CI gate: typecheck + test + hermetic e2e + build smoke + `node --check` | inner | The v0.1.0 PR/push CI gate (Biome scoped to changed files). |
| 038 | release-please v4 PR-gated pipeline + `engines.node` bump | inner | Automated PR-gated releases (release-type node) + Node engines bump. |

### Slice 1 — never-stuck (inner)

| # | Title | Ring | Summary |
|---|---|---|---|
| 039 | stop spurious `disconnected` broadcast on every tab switch (web + main) | inner | Fix the false disconnect on switch in both `remote-page-connector.js` and the `main.js` inline copy. |
| 040 | bounded-backoff auto-reconnect on real connection drop | inner | Reconnect with bounded backoff when the link genuinely drops. |
| 041 | timer WS reconnect while foregrounded | inner | Retry the WS on a timer while the tab is visible. |
| 042 | one-tap manual Reconnect (status bar + settings) | inner | Manual reconnect control in the status bar and settings. |
| 043 | fix `updatePin` to true partial patch (stop wiping url/title) | inner | Make pin updates merge instead of overwrite url/title. |
| 044 | per-build SW cache + update-available reload prompt | inner | Bust the service-worker cache per build and prompt to reload on a new build. |

### Slice 2 — iPad shell (inner)

| # | Title | Ring | Summary |
|---|---|---|---|
| 045 | landscape safe-area insets on top bar + left edge (beyond t015) | inner | Extend safe-area handling to the top bar and left edge in landscape (builds on done t015). |
| 046 | apple `status-bar-style` black-translucent meta | inner | Add the iOS status-bar-style meta for the standalone PWA. |
| 047 | lock `touch-action` + `user-scalable` so finger gestures don't pan the shell | inner | Prevent finger gestures and pinch-zoom from moving the shell. |
| 048 | 44pt touch targets on coarse pointer (clear t016 debt) | inner | Finish the 44pt hit-target debt t016 left for coarse pointers. |
| 049 | settings drawer: gate mouse-leave to fine pointer + tap-outside + close button | inner | Keep mouse-leave close for fine pointers only; add tap-outside + a ≥44pt close button for touch. |
| 050 | show version + build SHA in settings About row | inner | Surface the injected version/SHA in a settings About row. |

### Slice 3 — input feel (inner)

| # | Title | Ring | Summary |
|---|---|---|---|
| 051 | touch-scroll-tap: finger drag → `mouseWheel`, tap → click, long-press → right-click | inner | Lightweight finger forwarding reusing the existing mouse pipeline + `toRemoteCoords`. |
| 052 | local echo cursor + optimistic press for instant input feedback | inner | Echo the cursor locally and press optimistically so input feels instant. |

### Slice 4 — table-stakes latency

| # | Title | Ring | Summary |
|---|---|---|---|
| 053 | copy address action in tab + pin context menus | inner | Add a "Copy address" action to tab and pin context menus. |
| 054 | cap `everyNthFrame` + server frame-rate throttle to stop stale-frame pile-up | inner | Throttle screencast frame rate so stale frames don't pile up. |
| 055 | Sharp/Balanced/Snappy quality-latency tier picker | inner | A three-tier quality-vs-latency picker. |
| 056 | client ack-after-paint backpressure on web path (one frame in flight) | inner | One screencast frame in flight on the web path, acked after paint. |
| 057 | always-on metrics: WS RTT/jitter ping estimator + server frame-age timestamp | inner | Always-on RTT/jitter + frame-age metrics (builds on `src/lib/perf-mark.ts`) feeding the HUD. |
| 058 | Cmd+K command palette + `?` overlay + touch launcher | outer | The ⌘K palette, `?` shortcut overlay, and a touch launcher. |
| 059 | toggleable latency HUD (RTT/jitter/transport) in status bar, off by default | outer | A status-bar latency HUD, off by default, fed by t057's metrics. |
| 060 | document + surface the minimal proxy buffering config for fast input | outer | Document and surface the minimal upstream proxy buffering config. |

### Slice 5 — acceptance (inner)

| # | Title | Ring | Summary |
|---|---|---|---|
| 061 | e2e: WS→SSE fallback + reconnect resilience on a flaky link | inner | End-to-end resilience test for transport fallback + reconnect. |
| — | iPad couch finger-scroll/tap verification | inner | Not a new file — **amends t018** (see below). The HARD tag-blocking gate; runs **last**. |

### Amended / reused tasks (do not duplicate)

- **001 in-page-find-bar-cmd-f** — this *is* the find-bar item. Amended (note: the current `prompt()` is broken on iPad); keep its number.
- **003 ci-and-github-release-pipeline-signed-mac-claude-w** — rescoped: the v0.1.0 CI gate + release-please + version reset stay in scope (carved into 035–038); signed-mac Electron release + Claude-bot workflows marked **deferred v0.2** inside the file.
- **018 ipad-workday-verification** — the HARD GATE. Amended to add a couch finger-scroll/tap verification line (Magic Keyboard already assumed); runs last.

### Deferred to v0.2+

- **032 adopt-remote-page-connector-in-main** — left untouched, deferred to v0.2.
- Whole themes deferred: multiple-workspaces (ADR sketch only), latency codec Phase 2/3 (WebRTC/WebCodecs), Slack + work-app deepening, `app.tsx` effect-cluster extraction, on-screen-keyboard bridge, full `Input.dispatchTouchEvent`.

_Last revisited: 2026-05-30_
