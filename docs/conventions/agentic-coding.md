# Agentic coding

Optimize the codebase for AI agents (Claude Code first) and the humans who pair with them. The two audiences want similar things — clarity, predictability, signal-to-noise — and writing for both keeps the codebase navigable as it grows.

## The two principles

1. **Fresh, not patched.** Code and docs should read as if written intentionally from scratch with today's understanding — not as the seventeenth amendment to a 2022 design.
2. **Predictable patterns.** An agent (or a new contributor) should be able to predict where a thing lives and how it's shaped from one example. Surprise is the cost.

These compound: *fresh + predictable* means an agent can reliably reason about the codebase, modify it, and verify its work. Anything else is a tax on every future change.

---

## Fresh, not patched

When a function, file, or module no longer fits its current job, **rewrite it**. Don't append yet another conditional. Don't add a comment that says "this used to do X." Don't preserve dead structure for sentimental reasons.

**Symptoms of patched-not-fresh:**

- A function with five sequential `if` blocks that look like geological strata.
- Variables named after old concepts (`legacyFoo`, `oldStyleBar`).
- Comments that explain *what was true before* rather than *what is true now*.
- Dead branches kept "just in case." (Git remembers. Delete.)
- Configuration flags whose only purpose is to preserve old behavior nobody uses.
- Three abstractions where the original problem was solved by one.

**The discipline:**

- When you touch code that has accumulated scar tissue, **factor it down**. Same commit if scope allows; follow-up task if not.
- When you change a contract, **rename to match the new shape** — don't keep the old name as an alias forever. Brief deprecation aliases are fine; they should disappear within one or two iterations.
- When you rewrite a doc section, **rewrite it whole**. Don't bolt "Note: as of 2026-XX, this is now …" onto old prose. The doc should read as the current truth.
- **No "see also: previous versions" links** in docs unless they're ADRs (which are deliberately historical).

**The test:** if a new contributor or agent reads this file/module/doc cold, does it look like *one author writing it once* — or like *several authors patching over each other*? If the latter, refactor.

---

## Predictable patterns

Agents work by analogy. Show them one example, they extrapolate. If the codebase has consistent patterns, this works. If it has six ways to do the same thing, every change requires re-reading the whole repo.

**What to standardize:**

- **File and folder naming** — **kebab-case for ALL files, including React components.** A component lives in `notification-bell.tsx` and exports `NotificationBell`. PascalCase for types and exported components, camelCase for symbols, kebab-case for files. No mixed conventions. Biome enforces; if Biome accepts the filename, it's correct.
- **Module shape** — every `src/lib/` module follows the same skeleton (pure functions, no side effects, colocated `*.test.ts`). New modules don't invent new structures.
- **Test layout** — colocated `*.test.ts` for pure logic; `*.test.tsx` for React components. Always.
- **IPC shape** — every IPC handler in `main.js` has a symmetric handler registered with `ipcMain.handle`; the renderer calls it via `window.cdp` (the contextBridge surface). New CDP-bridging features follow this pattern.
- **Naming verbs** — `reconcile`, `reduce`, `forward`, `dispatch`, `capture` have specific meanings in this codebase (see `CONTEXT.md`). Use them consistently.

**The test:** can an agent given only one example of a `src/lib/` module correctly guess where the test lives, what the pure-function contract looks like, and how it's wired into `app.tsx`? If yes, the patterns are working.

---

## Naming as documentation

Code with good names needs few comments.

- **Functions describe behavior, not steps.** `toRemoteCoords(client, rect, dpr, frame)` over `getPos(...)`. The first tells you *what comes back*; the second tells you nothing.
- **Types describe shape, not source.** `ViewEntry`, not `DbEntry` or `RawEntry`. Source is implementation; shape is the contract.
- **Booleans describe truth, not state.** `isLoading`, `sidebarCollapsed`, `adaptiveViewport`. Avoid `loadingFlag`, `sidebarState`, `adaptiveMode`.
- **Constants describe meaning, not value.** `MAX_NOTIFICATION_CAP` not `FIFTY`.
- **Files describe their export.** `viewport-transform.ts` exports `Viewport Transform` functions. One concept per file when the concept is non-trivial.

When in doubt, ask: *"if I read only the name, would I know what to expect?"*

---

## Strong types as guard rails

TypeScript's job in this codebase is to make incorrect code unrepresentable. Lean on it.

- **No `any`.** Use `unknown` and narrow. If you must, comment why and treat it as debt.
- **Discriminated unions over flag fields.** `{ kind: "applyOverride", metrics: DeviceMetrics } | { kind: "clearOverride" }` over `{ kind: string; metrics?: DeviceMetrics }`.
- **`readonly` for immutable shapes.** Helps the agent (and the optimizer) know what can change.
- **Exhaustiveness checks** with `assertNever` on union dispatch. New variants force a compile error in every consumer.

```ts
function handleEffect(effect: AdaptiveEffect): void {
  switch (effect.kind) {
    case "applyOverride": return applyMetrics(effect.metrics)
    case "clearOverride":  return clearMetrics()
    // forgetting a new variant → compile error here:
    default: return assertNever(effect)
  }
}
```

---

## Test names as specifications

Tests are documentation that runs. Write them so `pnpm test` reads like a spec.

```
reconcile
  ✓ preserves existing tab order when remote list changes
  ✓ appends new tabs to the end in arrival order
  ✓ drops tabs that no longer appear in the remote list
  ✓ returns empty array when remote list is empty
```

vs.

```
tabs
  ✓ test 1
  ✓ should work
```

The first lets an agent understand what the module guarantees without reading the implementation.

---

## Comments — only the *why*

The code says *what*. Comments are for *why*, when *why* isn't obvious.

**Good:**

```ts
// CDP screencast requires an ack before pushing the next frame;
// without this the Remote Browser stalls the stream
ws.send(JSON.stringify({ id: ackId, method: 'Page.screencastFrameAck', params: { sessionId } }))

// Edge requires PUT for /json/new; Chrome accepts GET
const method = isEdge ? 'PUT' : 'GET'

// Renderer can't clear device-metrics override on tab switch because the socket
// is torn down first — main process must clear it on the outgoing socket
clearAdaptiveOverride(activeWs)
```

**Bad:**

```ts
// send ack
ws.send(...)

// switch tab
switchTab(id)
```

**Forbidden:**

- Comments referencing past versions ("// used to also handle X").
- Comments referencing session dates or AI sessions.
- Block-comment essays explaining why this is hard (move to ADR instead).
- AI attribution of any kind.

When you find yourself reaching for a comment, ask: *"can I rename, restructure, or extract instead?"*

---

## JSDoc: what types don't say

JSDoc in this codebase fills the gap between what TypeScript enforces and what a reader needs to confidently call a function.

**Write JSDoc when:**

- A function has non-obvious preconditions (`frame` must have been validated before calling `letterbox`).
- A parameter's *meaning* isn't captured by its type (`dpr: number` — is this the window's devicePixelRatio or the frame's?).
- The return value has a gotcha (`toRemoteCoords` returns `null` when the pointer is in the letterbox area outside the frame).
- A module-level invariant needs stating once (`// At most one RemotePage exists at any time`).

**Don't write JSDoc when:**

- The type signature is self-explanatory (`function cn(...inputs: ClassValue[]): string`).
- The JSDoc would just restate the type (`@param id string - the tab id`).

Write intent, not type. A `@param` that repeats the TypeScript type is noise. A `@param` that explains *what the value means in this context* is signal.

---

## Module-level signals for agents

Each area's `CLAUDE.md` is the agent's map. The discipline:

- **Up to date.** Matches the code's current shape. No stale claims.
- **Cover:** *Purpose · Contract · Where this fits · Watch out for* — same sections everywhere; agents pattern-match.
- **"Watch out for"** is the most valuable section to a returning agent. Keep it sharp.
- **Diagrams** (ASCII or Mermaid) in "Where this fits" — visual structure is high-bandwidth.

See [docs-discipline.md](docs-discipline.md) for the full template.

---

## Anti-patterns

- **"Backwards-compat shim" code that isn't documented as temporary.** Either it's permanent (give it a real name) or it's a migration bridge (document the removal date).
- **Generic helper modules** (`utils/`, `helpers/`, `lib/misc.ts`). They become dumping grounds. If a function doesn't have a home, it doesn't have a clear purpose. `src/lib/utils.ts` exists for `cn()` only; don't grow it.
- **TODO comments without owners or tasks.** A TODO without a task file behind it is a wish. Convert to a task or delete.
- **Silently absorbing out-of-scope work.** When a new request arrives mid-task, classify it before acting — see the [scope-guard discipline](dev-lifecycle.md#scope-guard-mid-task).
- **Hand-rolling CDP plumbing inline.** Any new CDP method call belongs in `remote-page.ts` (renderer-side named intention) or in an IPC handler in `main.js`. Never scatter raw `ws.send(...)` calls across callers.

---

_Code that reads as if written today, every day, is code that's still alive._

_Last revisited: 2026-05-23_
