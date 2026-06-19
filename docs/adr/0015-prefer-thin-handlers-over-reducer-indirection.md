# ADR-0015: Prefer thin handlers + small helpers over reducer/event-bus indirection where orchestration is already concentrated

- **Status:** Accepted
- **Date:** 2026-06-20

## Context

An architecture investigation (t096) ran finder agents that proposed seven
"deepening" refactors — each suggesting a new reducer, event-bus, or
effect-directive layer to concentrate logic alleged to be scattered across the
codebase. Adversarial verification against the real code **refuted four of them
outright** and down-scoped two more:

- **A1 Tab Lifecycle Orchestrator** — decisions already concentrated in the pure
  `tab-lifecycle.ts` planner (`planClose`/`planSwitch`, 18 tests); the renderer
  already applies directives thinly. `main.js`/`server.mjs` do a tabId-keyed CDP
  connect, not lifecycle. No scatter to concentrate.
- **A2 Notification Store reducer** — handlers already live in one ~100-line
  `app.tsx` block; the read model (`groupByConversation`) is already a shared
  pure module; the server `notificationCenter` is already the authoritative
  writer. No competing-writers problem.
- **A4 Input Intent Builder** — `forwardInput(InputIntent)` is already a single
  tagged-union seam; `toRemoteCoords` is applied exactly once; t084's on-screen
  keyboard already proved a new input modality drops into the existing seam.
- **A6 Slack Sweep event stream** — the runner already owns the state machine
  (seed-vs-sweep, restricted fallback, stale-vs-permanent error); 429s are
  handled in `slack-api.js`; the server only supplies DI deps + trigger sites.

In each case the **deletion test** showed the orchestration was already deep —
concentrated behind a seam — so wrapping it in a reducer/event-bus would
*relocate* clean code, not concentrate scattered code. The proposals also added
speculative machinery (a settings save-queue, offline handling, an event queue)
for failure modes with no observed evidence.

## Decision

Where the deletion test shows orchestration is **already concentrated behind a
seam**, prefer the smallest change that removes the *actual* friction:

- a thin optimistic handler,
- a small shared helper (e.g. `applyCloseDirective`, an optimistic-mutate +
  revert helper, a debounced `scheduleSweep`),
- or lifting an already-DI'd factory into its own tested file.

Reject "deepening" whose only effect is to rename or relocate code that already
passes the deletion test. A reducer/event-bus/effect-directive layer is
warranted only by **real, observed scatter across N callers** — not by a large
file, a conceptually-separable concern, or a hypothetical future modality.

## Consequences

- A future `/improve-codebase-architecture` run that re-surfaces A1, A2, A4, or
  A6 should be closed by reference to this ADR — unless new scatter has actually
  appeared since (re-run the deletion test to confirm).
- The bar for introducing a reducer/event-bus is explicit: point at the N caller
  sites that each re-implement the orchestration. If you can't, it's already
  deep.
- This does **not** forbid the small fixes the same investigation kept (t096):
  consolidating the genuinely-duplicated settings ui-state load/write owner
  (A3), extracting already-DI'd-but-inline transport factories for testability
  (A5), and adding revert-on-fail to optimistic handlers (A2's real defect). The
  no is specifically to the reducer/event-bus *shape*, not to removing real
  duplication.

## Alternatives

- **Build the reducers/event-buses as proposed** — rejected. Verification found
  no scatter to concentrate; the indirection would add a layer a future reader
  must traverse to follow already-local logic, harming the locality it claimed
  to improve.
