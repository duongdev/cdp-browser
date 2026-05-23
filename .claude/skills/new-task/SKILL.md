---
name: new-task
description: Scaffolds the next-numbered docs/tasks/ file from the task template, filling only the title line. Use when the user says "create a task", "new task", "/new-task", or a piece of work needs its own task file before it can be picked up.
model: haiku
---

# CDP Browser new-task scaffold skill

Creates an empty, correctly-numbered task file. It does **not** start or close
the task — the [`task`](../task/SKILL.md) lifecycle skill handles pickup and
closure. This is create-only; the two are deliberately separate tools.

## What it does

- Scans `docs/tasks/*.md` and `docs/tasks/done/*.md` for the highest 3-digit
  prefix, takes max+1.
- Slugs the title (Vietnamese diacritics fold to ASCII) and writes
  `docs/tasks/<NNN>-<slug>.md` from `docs/tasks/TEMPLATE.md`, replacing only
  the first-line title.

## How to run

```
node scripts/cdp-commands/new-task.mjs "$ARGUMENTS"
```

Report the created path. The user fills in the rest of the file — do not invent
Goal, acceptance criteria, or any other section.
