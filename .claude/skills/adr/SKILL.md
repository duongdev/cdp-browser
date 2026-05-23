---
name: adr
description: Scaffolds the next-numbered docs/adr/ file from the ADR template, filling the title, Status (Proposed), and Date lines. Use when the user says "write an ADR", "record this decision", "/adr", or an architectural decision needs recording.
model: haiku
---

# CDP Browser adr scaffold skill

Creates an empty, correctly-numbered ADR file. It does not decide anything —
it gives the decision a home.

## What it does

- Scans `docs/adr/*.md` for the highest 4-digit prefix, takes max+1.
- Slugs the title (Vietnamese diacritics fold to ASCII) and writes
  `docs/adr/<NNNN>-<slug>.md` from `docs/adr/TEMPLATE.md`, replacing the
  first-line title, setting `- **Status:** Proposed`, and stamping
  `- **Date:**` with today's local date.

## How to run

```
node scripts/cdp-commands/adr.mjs "$ARGUMENTS"
```

Report the created path. The user fills in Context, Decision, Consequences, and
Alternatives — do not invent the decision content.
