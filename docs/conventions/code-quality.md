# Code quality

The standards every change must meet. Engineering discipline: SOLID, atomicity, back-compatibility, and refactor-on-touch.

## SOLID, applied to this codebase

The classical principles, grounded in the main+renderer architecture.

### S — Single Responsibility

A module, class, or function has **one reason to change**.

**Smell:** a file imports from three unrelated subsystems, or its name has "and" in it.
**Fix:** split. A 200-line file doing one thing beats a 50-line file doing three.

In CDP Browser: `src/lib/viewport-transform.ts` only knows about coordinate math. It does not know about React state, IPC, or CDP connections. `notifications.js` only knows about dedup logic — it does not open sockets or fire Electron `Notification`. Effects stay in `main.js`; pure logic stays in the module.

### O — Open/Closed

Modules are open for extension, closed for modification. New behavior is added by composition, not by editing existing code.

**In practice:** adding a new `InputIntent` variant (e.g. IME composition) means adding a variant to the `InputIntent` union and one `case` in `forwardInput`. No other interface changes. Same pattern for Notification Adapters: add an adapter object; the dispatch loop doesn't grow a new `if`.

### L — Liskov Substitution

Anything implementing an interface must honor its contract. No surprising downcasts.

**In practice:** the `Transport` interface in `remote-page.ts` is a structural type — `send`, `invoke`, `onEvent`, `onDisconnected`. The production transport (`window.cdp`) and the test fake both satisfy it; tests don't need to know which is active.

### I — Interface Segregation

Many small focused interfaces beat one large one.

**In practice:** `Transport` exposes only what `createRemotePage` actually needs — not the full CDP surface. When Notification Side-Channel was added, it didn't widen `Transport`; it operates on a separate WebSocket entirely.

### D — Dependency Inversion

High-level modules depend on abstractions, not concretions.

**In practice:** `createRemotePage` depends on `Transport`, not on `window.cdp`. The caller wires the concrete implementation. This is what lets tests run without a live Remote Browser.

---

## Atomicity

Every commit is a complete, shippable change. Every PR does one thing.

**Atomic ✓**
- `feat(viewport): add letterbox offset to toRemoteCoords` — one fix, one test, one commit.
- `fix(tabs): handle duplicate tab IDs in reconcile` — one bug, one test reproducing it, one fix.
- `refactor(notifications): extract dedup logic to pure function` — pure refactor, behavior unchanged, tests still green.

**Not atomic ✗**
- `feat: add viewport fix + refactor notifications + update settings` — three things, can't revert one without losing the others.
- `wip: stuff` — never.

If a feature is genuinely large, split it into atomic commits that each leave the system green:

```
feat(adaptive-viewport): add reduce state machine
feat(adaptive-viewport): wire reduce into app.tsx
feat(adaptive-viewport): apply override in main process on connect
```

Each commit independently passes tests and lint. The system is shippable at every commit.

---

## Back-compatibility

**Default: additive over breaking.**

Settings in `settings.json` are persisted to disk — a breaking schema change will corrupt the user's config on upgrade. Discipline:

- Add new settings fields with sensible defaults that preserve the old behavior.
- Migrate in `loadSettings()` — see the `switchBlur` → `switchEffect` migration in `main.js` as the canonical pattern.
- Remove old fields only after the migration has shipped for at least one version.

Renaming a public function in `src/lib/`? Add the new name, deprecate the old with a comment, remove in the next task. Brief aliases are fine; they should disappear within one or two iterations.

---

## Fresh, not patched

When a function, file, or doc accumulates scar tissue, **rewrite it** rather than appending another conditional or "note: as of …" sentence.

Symptoms to watch for: variables named `legacyFoo`, comments explaining what *used to be true*, sequential `if` strata that look geological, dead branches kept "just in case." Fix in the same commit if scope allows; otherwise capture as a follow-up task.

Full discipline: [agentic-coding.md](agentic-coding.md#fresh-not-patched).

---

## Seamless version upgrades

The project will outlive its initial dependency choices.

- **Lockfile committed.** Always. `pnpm-lock.yaml` is part of the repo.
- **One package per PR** unless a coupled set must move together (e.g. `electron` + `electron-builder`).
- **Read the CHANGELOG** of every version skipped. Don't jump from v3 to v6 without acknowledging v4 and v5.
- **Major version bumps** are architectural decisions → require an ADR.
- **Run `pnpm test` and `pnpm dev`** after any dep upgrade — the renderer and the main process both need to boot.

---

## Refactor-on-touch, bounded

When you modify a function, leave it cleaner than you found it. **Within the blast radius of your change.**

**OK ✓**
- You're adding a parameter to `toRemoteCoords`. While there, you notice a confusingly named local variable. Rename it. Same commit.
- You're fixing a bug in tab reconcile. The function has grown to 60 lines. Extract the new-tab detection to a named helper. Same commit (if scope allows) or follow-up commit.

**Not OK ✗**
- You're patching the letterbox math and decide to refactor how `app.tsx` manages tab state. Out of scope. Capture as a separate task.
- You're touching `main.js` for a notification fix and notice an unrelated endpoint has dead code. Don't touch it. Capture as a follow-up.

---

## Things to avoid

### No dead code, ever

- No commented-out code. Git remembers it.
- No unused imports, unused variables, unused functions.
- No "we might need this later" stubs.
- When you orphan a function during a change, delete it in the same commit.
- TODO comments without an owning task are wishes. Convert to a task or delete.

### No premature abstraction (DRY done right)

- Three repetitions before you abstract. Two is coincidence.
- A single-use helper is fine; a single-use abstraction is overhead.
- When you do abstract, give the helper a name that earns its keep — not `helpers.ts`, `lib/misc.ts`. Generic names are dumping grounds.

### Native first, then a library

Reach for **native ES first** — `structuredClone`, `Object.groupBy`, `Array.prototype.*`, `Map`/`Set`. Most utility operations are covered without adding a dependency. Add a utility library only when it makes a *real, present* operation materially more readable, and justify it in the task file.

### No defensive code at internal boundaries

- Validate at *system boundaries*: settings loaded from disk, CDP responses from the Remote Browser, IPC messages arriving in the renderer.
- Inside the system: trust your types. If a `Tab.id` is `string`, don't null-check it in every consumer.
- Exception: invariants critical to correctness (e.g. "exactly one Remote Page must exist") — assert these even internally.

### No magic strings or numbers

- Named constants for anything used in more than one place.
- Named discriminants for closed unions.

### No silent failures

- Errors propagate. If you catch, you do something — log with context, transform to a domain error, or recover with a value.
- `try/catch` that does nothing is a bug. This is especially important in WebSocket handlers: a swallowed error in the IPC layer leaves the renderer in an unknown state.

### No comments that say what

```ts
// Increment counter      ← no
counter++

// CDP screencast requires an ack before the next frame is pushed;
// skipping it causes the remote browser to stall the stream
ws.send(JSON.stringify({ id: ackId, method: 'Page.screencastFrameAck', params: { sessionId } }))
// ← yes
```

Comments explain *why*, never *what*. Identifiers do the *what*.

### No AI attribution

- Never "Co-authored-by: Claude" or similar in commits.
- Never "// generated by AI" or similar in code.
- Never reference AI authorship in PRs, READMEs, ADRs, or commit messages.

---

## Error handling

There is no project-wide error class hierarchy — this is not a large enough codebase to warrant one. Rules:

- **Main process:** errors in IPC handlers are logged to `console.error` with context (what was attempted, the error message). Never swallow. When the error is recoverable (e.g. a failed CDP call), send an IPC reply with `{ error: string }` and let the renderer surface it.
- **Renderer:** errors at async boundaries use typed discriminated returns or `try/catch` that renders an appropriate state. Never propagate raw `Error` objects to JSX.
- **Pure modules (`src/lib/`, `notifications.js`):** throw on invariant violations; return `null` or a typed result for expected "miss" cases. Document which is which.
- **Wrap render boundaries with ErrorBoundary** at the top level so a crash in one component doesn't blank the whole window.

---

## TypeScript-specific

- `strict: true` always. No `any`. Use `unknown` and narrow. If you must use `any`, comment why and treat it as debt.
- No `@ts-ignore` without a comment explaining why and a follow-up task.
- Discriminated unions over flag fields. `{ kind: "send", text: string } | { kind: "edit", selectionText: string }` over `{ kind: string; text?: string; selectionText?: string }`.
- `readonly` for immutable shapes.
- Exhaustiveness checks with `assertNever` (or `satisfies`) on union dispatch — new variants force a compile error in every consumer.

---

## Quality gates (mechanical)

These run on every commit (pre-commit hook) and should run before every PR merge:

- **Lint + format** — `pnpm check` (Biome). Errors fail the build.
- **Typecheck** — `pnpm typecheck`. Must be clean.
- **Unit tests** — `pnpm test` (Vitest). Must be green.
- **No new dependencies** without an ADR or task-file justification.
- **Dev server boot** — `pnpm dev` must start cleanly for any change touching `main.js`, `preload.js`, or Vite config.

---

_Code quality is built one commit at a time. There's no "fix it later" pass that ever happens._

_Last revisited: 2026-05-23_
