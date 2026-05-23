---
name: idea
description: Captures a raw, unstructured idea as a timestamped top entry in docs/memories/ideas.md. Use when the user says "capture an idea", "/idea", or floats a future improvement worth recording before it's lost.
model: haiku
---

# CDP Browser idea capture skill

This skill is a thin pointer to a tested repo script — deterministic logic
lives in `scripts/`, not here.

Prepends a one-line, timestamped idea to the top of `docs/memories/ideas.md`.

Run, passing the idea text verbatim:

```
node scripts/cdp-commands/idea.mjs "$ARGUMENTS"
```

Report the updated path printed to stdout. If exit code is non-zero, surface
the usage line from stderr to the user and stop.
