---
name: status
description: Prints a one-screen orientation block — in-progress tasks, top open risks, next ready-to-pick tasks. Use when the user says "where are we", invokes /status, returns after a break, or asks what to work on next.
model: haiku
---

# CDP Browser status skill

A read-only re-orientation snapshot. Safe to run anytime — no file writes.

## What it shows

- **In progress** — task files outside `done/` with `Status: in-progress`.
- **Top open risks** — the first 3 🔴 risks from `docs/memories/risks.md`.
- **Next ready** — `ready` tasks whose every dependency is in `done/`.
- A one-line drift warning if a task's status header and its `done/`
  location disagree.

## How to run it

```
node scripts/cdp-commands/status.mjs
```

Print the script's output verbatim to the user — do not summarize, reorder,
or re-interpret it.
