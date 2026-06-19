# Development lifecycle

How a piece of work moves from idea to merged code. The discipline is small but every step exists for a reason.

## The loop

```
┌─────────┐     ┌─────────┐     ┌─────────┐     ┌─────────┐     ┌─────────┐
│ CAPTURE │ ──▶ │  SPEC   │ ──▶ │  BUILD  │ ──▶ │  PROVE  │ ──▶ │  SHIP   │
└─────────┘     └─────────┘     └─────────┘     └─────────┘     └─────────┘
   idea →         task file       TDD loop        all gates        merged,
   memory         + test plan     + refactor       pass            docs alive
```

## 1. Capture

An idea, a risk, a question, a "huh, that's weird." Write it down before you forget.

- A risk → append to [`docs/memories/risks.md`](../memories/risks.md).
- A learning, surprise, or insight → [`docs/memories/learnings.md`](../memories/learnings.md) (or a new file in `docs/memories/` if it warrants its own).
- A future capability idea → [`docs/memories/ideas.md`](../memories/ideas.md).
- A discrete unit of work → new file in [`docs/tasks/`](../tasks/) using the [TEMPLATE](../tasks/TEMPLATE.md).
- A non-trivial design decision being made → new ADR in [`docs/adr/`](../adr/).

## 2. Spec

Before writing code, the task file must answer:

- **What problem are we solving?** One paragraph, plain language.
- **Acceptance criteria.** What must be true for this to be "done"? Bullet list, testable.
- **Test plan.** Which of the three testing layers apply? What are the explicit test cases? See [tdd.md](tdd.md).
- **Design notes.** Module(s) touched, contracts changed, dependencies added. Sketch the diff before writing it.
- **Out of scope.** What we're explicitly *not* doing in this task. Prevents scope creep mid-build.
- **Definition of Done.** A checklist that mirrors the project's quality bar (see end of this doc).

A task must be sized so it **fits in one Claude Code session at 1M context, including verification and feedback resolution, without compaction.** Roughly half a day of focused work. Larger than that → split.

**Why the strict cap:** compaction loses fidelity. The design intent, early test failures that shaped the implementation, and already-incorporated feedback all get summarized away. Splitting is cheaper than redoing.

**Test of "too big":** if you can't list every file you'll touch and every test you'll write in under 60 seconds, the task is too big.

### Ask, don't assume

When the spec has ambiguity:

- **Surface it.** Add an "Open questions" bullet to the task file.
- **Stop and ask** when the ambiguity affects design — not after coding down one path.
- **Document the answer in the task file** when it lands. Future-you will want to know why X over Y.

Assumptions become bugs faster than mistakes do. Cheap to ask now, expensive to undo later.

## 3. Build (TDD loop)

The core loop for every task with logic:

```
write failing test  →  minimum code to pass  →  refactor with tests green  →  commit
```

See [tdd.md](tdd.md) for which layer applies to which kind of code. Two non-negotiables for pure-logic work:

1. **Test before implementation.** If a test feels impossible to write, the design is wrong — pause and rethink.
2. **Refactor with tests green.** Tests are the safety net for changing structure without changing behavior.

While building, also:

- **Refactor on touch, bounded.** When you modify a function, leave it cleaner than you found it — *within the blast radius of your change*. No drive-by refactors of unrelated code. See [code-quality.md](code-quality.md).
- **Fresh, not patched.** When code accumulates scar tissue, rewrite instead of layering more conditionals. See [agentic-coding.md](agentic-coding.md#fresh-not-patched).
- **Update docs as you go.** If you change a contract or module shape, update its `CLAUDE.md` in the same commit. See [docs-discipline.md](docs-discipline.md).
- **Don't batch unrelated changes.** Each commit does one thing. See [git.md](git.md).

### Scope guard mid-task

Requests come in mid-task — from you, from the user, from "I just noticed…" thoughts. Each one is a fork. The default:

1. **Check the request against the task's *Out of scope* section.**
2. **Classify:**
   - **In scope** → proceed.
   - **Out of scope, trivial** (typo in a file you're editing, broken link in a doc you're touching) → fix and mention.
   - **Out of scope, non-trivial** → stop and ask.
   - **Not planned at all** → stop and ask.
3. **Name it explicitly.** Say: *"This is out of scope of task NNN — it belongs to task MMM (or no plan yet). Do you want to do it now, defer, or just capture it?"*
4. **Three paths:**
   - **Do it now** — explicit acceptance of scope expansion; note it in the task's *Notes* section.
   - **Defer** — link to where it'll be done.
   - **Capture only** — append to `docs/memories/ideas.md` or `risks.md`; resume the current task.

The one-session task cap means scope creep saturates context and forces compaction — the number-one failure mode that breaks task atomicity.

## 4. Prove

Before merging, the task's Definition of Done must be true:

- [ ] All relevant testing layers green (see [tdd.md](tdd.md))
- [ ] `pnpm check:changed` clean (Biome scoped to your diff — the CI gate; `pnpm check` fails on pre-existing dirt in untouched files so it is not the gate)
- [ ] `pnpm typecheck` clean (no `any`, no `@ts-ignore` without justification comment)
- [ ] No new dependencies without an ADR or a one-liner in the task file justifying it
- [ ] `CLAUDE.md` for any modified module reflects reality
- [ ] ADR written if an architectural decision was made
- [ ] `pnpm dev` boots cleanly and the changed surface works end-to-end — "tests pass" ≠ "the app runs"
- [ ] Manual smoke test: the feature actually works with realistic data (live Remote Browser or equivalent)
- [ ] No commented-out code, no `console.log` debris, no AI attribution
- [ ] **Task closed** — status set to `done` and file moved to `docs/tasks/done/`; tNNN stamped in the commit

## 5. Ship

- Branch named per [git.md](git.md): `<type>/t<NNN>-<short-kebab>`
- Commit message: semantic title only, lowercase, no body, with ` (tNNN)` suffix
- Self-merge after the checklist passes

### Closing the task (the step that gets forgotten)

Closure rides in the **same commit** as the code. Code merged with the task still open is a defect. The four mutations:

1. Task file header → `**Status:** done`
2. `git mv docs/tasks/NNN-<slug>.md docs/tasks/done/NNN-<slug>.md`
3. Any mid-task deferrals captured as their own tasks/ideas/risks
4. Task ID stamped in the branch, commit, and PR

## Anti-patterns

- **"I'll write tests after."** No. The test goes first for pure logic. Write-after means the test is shaped by the code, not the requirement.
- **"Small change, no need to update docs."** If the change is large enough to commit, it's large enough to update docs.
- **"I'll fix this unrelated thing while I'm here."** Capture it as a task. Do it next. Don't bundle.
- **"This task got bigger than expected, but I'm almost done."** Stop. Either ship the small part and create a follow-up, or split properly.

## When to break the rules

- **Spike code** — when you genuinely don't know what shape a CDP or IPC solution should take, write throwaway code to learn, then delete it and start TDD-first. Spike code never merges.
- **Emergency hotfix** — minimum code + minimum test to stop the bleed. Then write a proper task capturing the lesson and any cleanup needed.

Both cases require an explicit "this is a spike" or "this is a hotfix" acknowledgement, not silent rule-bending.

---

_Conventions are stable. Open an ADR if you want to change one._

_Last revisited: 2026-05-23_
