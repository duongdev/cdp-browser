---
name: regression
description: Runs the end-to-end regression pass against an isolated mock stack — boots the stack, fans the checklist out to subagents by area, collates verdicts and defects. Use when the user says "run regression", "run the QA pass", "/regression", or a task is at PROVE and needs the chat surface re-verified.
---

# CDP Browser regression skill

Drives [docs/conventions/e2e-verification.md](../../../docs/conventions/e2e-verification.md).
Read it before the first run — the rules there are the contract; this file is the procedure.

The two rules that make or break a run:

- **You (the orchestrator) never execute test cases.** Subagents do. You get verdicts, not evidence.
- **Subagents drive the UI with real input events** (`page.click`, Chrome DevTools MCP, CDP
  `Input.*`). A synthetic `dispatchEvent` bypasses `pointer-events` and reports a false PASS.

## 1. Pick a run id and boot an isolated stack

Node 24 (`nvm use 24`) — `better-sqlite3` is built for that ABI.

```bash
MOCK_DIR=.mock-data-<run> WEB_PORT=<p> BFF_PORT=<p+10> pnpm chat:mock
```

Default `<p>` is 7900; use 7920, 7940 … for concurrent runs. Never reuse a port or a `MOCK_DIR`
across live runs, and never point at the real stack. Wait for `/api/chat/conversations` on
`WEB_PORT` to answer before dispatching.

## 2. Choose the scope

- **Fix verification** — the failed case IDs plus their component's neighbours.
- **Task PROVE** — the areas the change can reach.
- **Full sweep** — every area; end of a task only.

Cases live in [docs/testing/chat-qa.md](../../../docs/testing/chat-qa.md), grouped by area
(Delivery, Edit/delete history, Settings, Hover overlays, Composer, Assistant, Links, Conversation
list, Core regression).

## 3. Dispatch one subagent per area

One `Agent` call per area, in a single message so they run in parallel. Give each subagent:

- the run's URL (`http://localhost:<WEB_PORT>/chat`) and `MOCK_DIR`;
- the verbatim case rows for its area;
- a screenshot dir (`/tmp/<run>/<area>/`);
- these instructions:

> Drive the UI with real input events only — Playwright/CDP/Chrome DevTools MCP. `evaluate_script`
> reads state, it never clicks. Run every content-bearing case twice: shortest plausible value and an
> abusive one (80+ char name, 200-char topic, 4000-char message, 300-char URL, 12 reactions, empty
> and one-item lists). Check both themes and 390×844 for any layout case. Do not edit files, commit,
> or stash. Do not boot another stack.
>
> Return ONLY a table: `case-id | PASS | FAIL | BLOCKED` plus, per failure, one line of symptom and
> the minimal repro. No screenshots, no DOM dumps, no logs, no narration. Screenshots stay on disk;
> give the path only.

## 4. Collate and act

- Merge the verdicts into one defect list, ranked: data loss > broken flow > visual.
- Fix in the main session (subagents don't write), then re-dispatch only the affected case IDs.
- Append a case for every defect fixed — that is the point of the checklist.
- Update `docs/testing/chat-qa.md`: new rows, and the **Last run** line (date · commit SHA · tally).

## 5. Tear down

Stop the stack (`Ctrl-C` kills both processes) and `rm -rf $MOCK_DIR`. Report to the user: pass/fail
tally per area, the defect list with repro steps, and what was fixed vs filed.

## Guardrails

- No script backs this skill — `pnpm chat:mock` already boots the stack. Don't add one unless the
  dispatch itself becomes mechanical.
- Never run the pass inline "just to save a subagent". That is how the orchestrator's context dies.
- A case that can't be driven by a real event is `PASS (synthetic)`, never `PASS`.
- Areas needing network, a real tenant, or a device stay in the checklist's "cannot be verified
  locally" table — mark them `BLOCKED`, don't fake them.
