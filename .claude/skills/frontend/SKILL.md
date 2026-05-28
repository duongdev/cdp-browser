---
name: frontend
description: Use when working on CDP Browser's renderer (src/). Triggers on tasks involving React components, src/lib domain modules, Tailwind v4 + shadcn UI, Vitest tests, or anything visible in the Electron window. Loads the frontend conventions before code is written so the work follows established standards.
---

# CDP Browser frontend skill

This skill is a pointer, not a duplicate. The conventions are the contract —
read them before writing any renderer code, and re-read when scope expands.

## Required reading (in this order)

1. **[src/lib/CLAUDE.md](../../../src/lib/CLAUDE.md)** — domain modules: Remote Page, Tabs, Viewport Transform, Adaptive Viewport, Notifications View, Pins, Local Tabs, Closed Tabs, Active Order, Key Routing.
2. **[CONTEXT.md](../../../CONTEXT.md)** — domain vocabulary; use these terms in code, tests, and docs.
3. **[docs/conventions/frontend.md](../../../docs/conventions/frontend.md)** — renderer stack, shadcn-first, state split, patterns.
4. **[docs/conventions/ux.md](../../../docs/conventions/ux.md)** — keyboard-first parity, focus management, accessibility.
5. **[docs/conventions/agentic-coding.md](../../../docs/conventions/agentic-coding.md)** — predictable patterns, naming, comment-the-why.
6. **[docs/conventions/tdd.md](../../../docs/conventions/tdd.md)** — three-layer test model for an Electron CDP app.
7. **[docs/conventions/code-quality.md](../../../docs/conventions/code-quality.md)** — SOLID, atomic commits, back-compat.
8. **[CLAUDE.md (root)](../../../CLAUDE.md)** — project-wide hard rules, branch naming, quality gates.

If a relevant convention is **missing**, write it first in the appropriate
`docs/conventions/` file, then implement.

## Verification before declaring done

Run from the repo root:

```bash
pnpm test
pnpm typecheck
pnpm check
```

Plus a visual check via Chrome MCP against `vite dev` (or the running app):

- Light theme and dark theme
- No layout shift, no console errors

CDP Browser runs as an Electron desktop app and as a web/iPad PWA. For desktop
renderer changes, verify at ~1280×800+. For web-build or layout changes, also
check at iPad widths (≤1100px viewport) where the sidebar defaults to 180px and
safe-area insets apply. The web build adds breakpoint-aware defaults but no
separate mobile-only codebase — one renderer, capability-split via `webCaps`.

If the change is not browser-observable (config, types, tests only), say so
explicitly — don't claim visual verification you didn't do.

## Scope guard

If the task drifts beyond what was requested (touches new modules, adds
unscoped abstractions, refactors adjacent code), STOP and surface the drift.
Silent scope absorption breaks the one-session cap.
