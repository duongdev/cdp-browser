# E2E verification and regression

[tdd.md](tdd.md) covers the three layers that prove a *change* works. This file covers the fourth
job: proving the *app still works* after it — end-to-end, against a running stack, driven by an
agent, without the orchestrator drowning in evidence.

Two rules carry most of the value. If you read nothing else:

1. **Regression runs in a subagent.** The orchestrator gets a verdict, never the raw evidence.
2. **Drive the UI with real input events.** `page.click()` / CDP input — never
   `element.dispatchEvent(...)`.

---

## 1. Regression runs in a subagent

A verification pass produces screenshots, DOM snapshots, network dumps, and long server logs. Any of
it in the orchestrator's context and the orchestrator stops being able to plan — it starts
summarizing evidence instead of shipping the task. This has cost whole sessions.

**The contract:**

- The orchestrator boots (or hands over) an isolated stack, then spawns one subagent **per area**
  (delivery, composer, links, assistant, conversation list …) with that area's case IDs.
- A subagent returns **only**: per-case `PASS` / `FAIL` / `BLOCKED`, and for each failure a one-line
  symptom plus minimal repro steps. No screenshots, no DOM dumps, no log paste, no narration.
- Screenshots stay on disk (`/tmp/<run-id>/`); the subagent reports the path if a human needs to
  look. The orchestrator does not read them unless a defect is disputed.
- The orchestrator's job is triage: collate verdicts, decide fix-now vs file, re-dispatch after fixes.

Areas run in parallel only when their stacks are isolated (rule 4). Sequential is fine and safer.

**Re-runs after a fix are scoped.** Re-dispatch the failed case IDs plus the cases that touch the
same component — not the whole checklist. Full sweeps happen at the end of a task, once.

## 2. Verification uses real input events

Synthetic events are a lie detector that fails open. `element.dispatchEvent(new MouseEvent("click"))`
bypasses hit-testing entirely, so it fires on elements that CSS `pointer-events`, a covering overlay,
`opacity: 0`, or a wrong z-index make unclickable by a human.

This is not hypothetical. During PSN-105 the profile-dialog → avatar-lightbox layering bug was
reported `PASS` by an agent that dispatched a synthetic click; the real pointer hit the dialog
backdrop and the lightbox never opened. The false PASS shipped the bug forward a whole session.

**Rules:**

- Click, type, hover, drag and key presses go through Playwright (`page.click`, `page.hover`,
  `page.keyboard`), the Chrome DevTools MCP, or CDP `Input.*`. These do real hit-testing.
- `evaluate_script` is for **reading** state (computed styles, element counts, store contents), never
  for driving it.
- If a case genuinely cannot be driven by a real event (a `document.hidden` override, a clock skip),
  say so in the case row and mark the result `PASS (synthetic)` — never a plain `PASS`.
- Assert on what the *user* would see: visible text, computed style, element geometry. "The handler
  ran" is not a pass.

## 3. Long and short content, every time

Every UI case that renders variable content is run twice — once with the shortest plausible value,
once with an abusive one. Overflow bugs only exist at the extremes, and this repo has shipped several
(a long job title escaping the profile dialog; a wrapped link's copy button landing off the line).

Vary, at minimum:

| Dimension | Short | Long |
|---|---|---|
| Display name | `Al` | 80+ chars, no spaces |
| Job title / presence line | empty | 120 chars |
| Conversation topic | one word | 200 chars, mixed scripts |
| Message body | one emoji | 4000 chars, one unbroken token |
| Link text | `ok` | a 300-char URL |
| Reactions | none | 12 distinct keys |
| Lists | 0 and 1 item | past one page |

Vietnamese and CJK text count as separate long cases where the surface is user-facing — line-height
and diacritic clipping differ from Latin.

Pair this with the standing UI expectations: **four states** (loading / empty / error / populated,
see [frontend.md](frontend.md#state-coverage)), **both themes**, and a **narrow viewport** (390×844).

## 4. One isolated stack per verification run

Parallel agents on a shared stack corrupt each other's results — and worse, each other's files. In
this repo two agents on one mock stack produced reverted edits and a committed scratch file.

Every run gets its own ports and its own data dir:

```bash
MOCK_DIR=.mock-data-a WEB_PORT=7900 BFF_PORT=7910 pnpm chat:mock
MOCK_DIR=.mock-data-b WEB_PORT=7920 BFF_PORT=7930 pnpm chat:mock
```

`MOCK_DIR` carries both `DATA_DIR` and `CHAT_DB_PATH`, so settings, the chat DB and push subs are all
per-run. Address the run's own port in every request (`pnpm chat:mock:say` reads `WEB_PORT`).

**Never point a verification run at the real stack.** No production BFF, no installed-app config, no
real Teams tenant — the mock provider (`CHAT_PROVIDER=mock`) is the only supported target.

A subagent that boots a stack owns it: tear it down before returning, and never `git commit`,
`git stash`, or edit source. Verification reads the tree; the orchestrator writes it.

## 5. Test cases are a durable asset

The checklist is the product of every previous session's pain. It is **extended, never rewritten**.

- The chat surface's cases live in [docs/testing/chat-qa.md](../testing/chat-qa.md). A new surface
  gets a sibling file, same shape: boot instructions, fixture table, `ID · steps · must happen`
  rows grouped by area, and a "cannot be verified locally" table.
- **Every fixed bug earns a case.** A defect found by QA, by a user, or by an agent gets a row in the
  area it belongs to, phrased as the observable symptom. That is what stops it coming back.
- Case IDs are stable and area-prefixed (`D-01`, `C-03`, `V-09`). Append within an area; never
  renumber, because task files, plans, and Linear comments cite the IDs.
- A case is only deleted when the feature is deleted. A case that no longer applies moves to the
  "cannot be verified locally" table with the reason.
- After a run, update the file's **Last run** line: date, commit SHA, and the pass/fail tally.
- Same commit as the code, like every other doc ([docs-discipline.md](docs-discipline.md)).

## 6. What a task owes this process

In the task file's **Test plan** section, name the case IDs the change touches and any new ones it
adds. At `PROVE` ([dev-lifecycle.md](dev-lifecycle.md)):

- [ ] `pnpm test`, `pnpm typecheck`, `pnpm check:changed` green
- [ ] `pnpm test:e2e` green when the change touches `web/server.mjs`, `core/`, or the BFF
- [ ] Regression dispatched to subagents for every area the change can reach
- [ ] Long-and-short content covered for every UI surface touched
- [ ] New cases appended to the checklist; `Last run` updated

Automated coverage always wins where it is possible: a bug reproducible in a pure function belongs in
a Vitest case, not a manual row. The checklist is for what crosses process boundaries and pixels.

---

## Running it

The [`regression` skill](../../.claude/skills/regression/SKILL.md) (`/regression`) automates the
dispatch: boot an isolated mock stack, fan the checklist out to subagents by area, collate verdicts.

---

_Last revisited: 2026-07-28_
