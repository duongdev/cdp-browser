---
name: learn
description: Records a hard-won lesson as a timestamped top entry in docs/memories/learnings.md. Use when the user says "we learned", "note that", "/learn", or a non-obvious lesson surfaces that's worth remembering.
model: haiku
---

# CDP Browser learning capture skill

This skill is a thin pointer to a tested repo script — deterministic logic
lives in `scripts/`, not here.

Prepends a timestamped paragraph to the top of `docs/memories/learnings.md`.

Run, passing the learning text verbatim:

```
node scripts/cdp-commands/learn.mjs "$ARGUMENTS"
```

Report the updated path printed to stdout. If exit code is non-zero, surface
the usage line from stderr to the user and stop.
