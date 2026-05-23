---
name: task
description: Manages the lifecycle of a docs/tasks/ task — pickup and closure (status, move to done/, CLAUDE.md status line, task-ID stamping). Use when starting or finishing a task, or when a task shipped but its file was left open.
model: haiku
---

# CDP Browser task lifecycle skill

This skill is an operational checklist. Read the task file end to end before
coding anything.

## Task ID — stamp it everywhere

Every task is `docs/tasks/NNN-<slug>.md`. `NNN` is the **task ID**. Repo-internal
and OSS-safe — not a private PM ticket ID. Stamp it into work materials:

| Material      | Format                                     | Example                                   |
|---------------|--------------------------------------------|-------------------------------------------|
| Branch        | `<type>/t<NNN>-<short-kebab>`              | `feat/t004-adaptive-viewport-polish`      |
| Commit title  | semantic title + ` (tNNN)` suffix          | `fix(viewport): correct letterbox math (t004)` |
| PR title      | same as commit title                       | `fix(viewport): correct letterbox math (t004)` |
| PR body       | link the task file                         | `Task: docs/tasks/004-viewport-polish.md` |

## On pickup (ready → in-progress)

1. Read the task file end to end. If any required section is missing, status
   is still `draft` — stop and resolve before coding.
2. Re-research before pickup: verify library versions against current docs
   (Context7) before writing code. CDP quirks and Electron APIs drift.
3. Set the task file header `**Status:** in-progress`.
4. Create the branch as `<type>/t<NNN>-<short-kebab>`.
5. Build TDD-first per `docs/conventions/tdd.md`.

## On close (in-progress → done) — the gate that gets forgotten

**A task is not done when the code works. It is done when this checklist is
green.**

1. **Definition of Done** — every box in the task file's DoD section is
   genuinely true. Quality gates green:
   - `pnpm test` — all vitest tests pass
   - `pnpm typecheck` — no type errors
   - `pnpm check` — Biome lint/format clean
   No AI attribution anywhere. **Plus the app boot check** when the task touched
   `main.js`, `preload.js`, Electron wiring, or build config: the app starts
   clean and the changed surface was exercised in the running app.
2. **Task file status** → change the header to `**Status:** done`.
3. **Move the file** → `git mv docs/tasks/NNN-<slug>.md docs/tasks/done/NNN-<slug>.md`
   (same filename — numbering stays stable).
4. **Root CLAUDE.md status line** → update the status sentence (if present)
   to reflect this task as complete.
5. **Spillover** → anything deferred mid-task must already be a new task file
   or a captured idea/risk. An undone item with no home is a closure blocker.
6. Hand off to the `/commit` skill (never auto-push).

**Closure is one commit with the code, or the immediately following commit —
never "later".**

## Self-check before declaring a task done

Answer all four "yes" or you are not done:

- Is the task file `Status: done` **and** physically in `docs/tasks/done/`?
- Does the root CLAUDE.md status sentence list this task ID as complete (if that
  line exists)?
- Do the branch, commit title, and PR carry `tNNN` / link the task file?
- Is every deferred item captured as its own task/idea/risk?

## Scope guard

If work drifts beyond the task's *Out of scope*, STOP. Surface the drift and
classify: new task, idea capture, or acknowledged acceptable expansion.
Silent scope absorption is the root cause of half-closed tasks.
