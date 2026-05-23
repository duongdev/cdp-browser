# Conventions

How we work. Read these before writing code.

## Reading order

1. [product.md](product.md) — the product bar: daily-driver browser, never-stuck experience
2. [dev-lifecycle.md](dev-lifecycle.md) — capture → spec → build → prove → ship
3. [tdd.md](tdd.md) — three-layer testing model tailored to an Electron CDP app
4. [code-quality.md](code-quality.md) — SOLID, atomicity, back-compat, fresh-not-patched
5. [agentic-coding.md](agentic-coding.md) — predictable patterns, naming, kebab-case, comment-the-why
6. [frontend.md](frontend.md) — renderer stack: React 19, Vite, Tailwind 4, shadcn, Zustand, HugeIcons
7. [ux.md](ux.md) — keyboard-first parity, ⌘K palette, `?` overlay, focus management
8. [git.md](git.md) — branches, semantic commits, tNNN task IDs, hard rules
9. [docs-discipline.md](docs-discipline.md) — docs stay alive, ADRs append-only, CONTEXT.md as glossary

## Why these exist

CDP Browser is small now and accumulates complexity quickly — CDP quirks, Electron IPC, renderer/main boundary, screencast timing. Conventions written before code stay light and useful. Conventions written after code are reverse-engineered apologetics.

If a convention proves wrong, change it via ADR — never silently. The rules are stable; the meta-rule (how rules change) is also stable.

## Changing a convention

1. Open an ADR in `docs/adr/` describing what's changing and why.
2. Update the convention file in the same PR.
3. Note in the ADR's *Consequences* section: what existing code or docs need to come into compliance.
4. Track that compliance work as a follow-up task.

## What conventions deliberately don't cover

- **Code style** (naming, indent, file ordering) — owned by Biome config. If Biome accepts it, it's fine.
- **Library choices** — owned by ADRs.
- **Per-area design** — owned by the area's `CLAUDE.md` (`src/lib/CLAUDE.md`, future per-subsystem notes).

Conventions are about *how we work* (or with our future selves). Implementation specifics live closer to the code.

_Last revisited: 2026-05-23_
