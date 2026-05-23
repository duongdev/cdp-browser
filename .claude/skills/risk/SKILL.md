---
name: risk
description: Appends a new open risk entry (next R-NNN, 🔴) to docs/memories/risks.md with a mitigation/trigger scaffold to fill in. Use when the user says "log a risk", runs /risk, or a new project risk surfaces in conversation.
model: haiku
---

# CDP Browser risk capture skill

This skill is a pointer, not logic. The deterministic numbering + append lives
in `scripts/cdp-commands/risk.mjs` (unit-tested): skills are thin shims over
repo scripts.

## What it does

Computes the next `R-NNN` as max+1 over every existing `### R-\d+` heading in
`docs/memories/risks.md` (the file is not R-number ordered, so this is
order-independent), then appends a new open (🔴) block with a `_To be filled._`
context line and an `_TBD_` Mitigation/Trigger scaffold.

## Command

```
node scripts/cdp-commands/risk.mjs "$ARGUMENTS"
```

Report the new `R-NNN` id and the file path back to the user. On a non-zero
exit, surface the script's usage line — a blank or missing title is rejected.
