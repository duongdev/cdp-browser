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

_Last revisited: 2026-05-23_
