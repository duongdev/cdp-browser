# Docs discipline

The project survives on docs that are accurate. The discipline below keeps them from rotting.

## What lives where

| Doc type | Audience | Cadence | Format |
|---|---|---|---|
| Root `CLAUDE.md` | Future-you, AI agents | When architecture changes | Short, link-heavy |
| `CONTEXT.md` | Anyone reading the code | When domain language changes | Glossary — definitions and relationships |
| `docs/conventions/*` | Contributors | Stable | Prose + examples |
| `docs/adr/*` | Anyone reading code | Append-only | ADR template |
| `docs/memories/*` | Future-you | As-discovered | Free-form |
| `docs/guides/*` | Operators and setup | When operational procedure changes | Step-by-step |
| `docs/tasks/*` | The task's executor | Per task | Task template |
| `<area>/CLAUDE.md` | AI / future-you reading that area | When internals change | 4-section template |

There are no per-area `README.md` files — this is a single app, not a monorepo. The root `CLAUDE.md` and the area `CLAUDE.md` files (e.g. `src/lib/CLAUDE.md`) serve the full audience.

## Small docs, linked, DRY

Prefer **many short docs, well-linked** over **few long docs that cover everything**.

- **Cap on doc length:** if a single `.md` exceeds ~400 lines, consider splitting. Long docs are skimmed, not read.
- **Link, don't duplicate.** If the same concept is discussed in two places, one is canonical and the other links to it. The canonical one lives wherever it's "owned."
- **DRY in docs is as important as DRY in code.** Duplicated information rots in different directions; pick one home.
- **Cross-reference instead of summarize.** Don't write "see also: …" with a re-summary; just link.
- **Index files point outward** — they list what's available, not what it contains.

A well-organized doc tree feels like a graph: dense links, small nodes. A poorly-organized one feels like an encyclopedia: long entries, sparse links.

---

## Per-area CLAUDE.md template

Every `src/lib/` module area and any subsystem complex enough to warrant documentation ships with a `CLAUDE.md` using this structure:

```markdown
# <area-name>

> One-sentence purpose.

## Purpose

What this module or area exists to do. Why it's separate from its neighbors.
What problems it owns and what problems it deliberately doesn't.

## Contract

The public API in shape, not in prose. Type signatures and one-paragraph
explanation per function. Link to the source file for implementation detail.

## Where this fits

How this module relates to its neighbors. What depends on it. What it depends on.
Why the boundary is drawn where it is. A small diagram helps.

## Watch out for

Non-obvious quirks, gotchas, performance cliffs, ordering constraints,
things that have bitten us in the past. The "if I had to brief a new
contributor in 5 minutes, what would I warn them about?" section.
```

The four sections are fixed. Don't add a fifth without an ADR. Don't drop a section because it feels empty — write "N/A" or a placeholder.

---

## CONTEXT.md as the domain glossary

`CONTEXT.md` at the repo root is the single authoritative source for domain vocabulary: Remote Page, Tab, Active Tab, Screencast Frame, Input Forwarding, Viewport Transform, Adaptive Viewport, Switch Effect, Notification Side-Channel, Notification Adapter, Notification Capture.

**The rule:** use the term from `CONTEXT.md` in code, tests, commits, and docs. No synonyms (e.g. "target" instead of "Tab", "webview" instead of "Remote Page"). When a new concept emerges with a clear boundary, add it to `CONTEXT.md` before writing any code for it.

Updates to `CONTEXT.md` that change meaning → open an ADR. Additive entries (new terms) → commit directly.

---

## Architecture Decision Records

Any non-trivial design decision gets an ADR. Examples of "non-trivial":

- Picking a library over an alternative.
- A constraint that overrides the obvious approach (e.g. "why WebSocket in main, not renderer").
- Test or build pipeline shape.
- An explicit "we won't do X" decision.

ADRs are **append-only**. When a decision changes, write a new ADR that supersedes the old one. Update the old ADR's *Status* line to reference the superseder, but never edit its body. The history is the documentation.

Current ADRs: `docs/adr/0001-single-remote-page.md`, `0002-adaptive-viewport.md`, `0003-notifications-side-channel.md`, `0004-pin-live-tab-model.md`, `0005-local-tabs-base-window.md`, `0006-web-proxy-sse-transport.md`, `0007-web-websocket-transport.md`, `0008-defer-monorepo-shared-cjs-core.md`, `0009-touch-first-co-primary-input-surface.md`, `0010-multiple-workspaces-deferred-design.md`, `0011-slack-content-sweep-guaranteed-delivery.md`, `0012-phone-triage-surface-inbox-rooted-shell-conversati.md`, `0013-per-device-notification-delivery.md`, `0014-endpoint-reconciled-per-device-push-identity.md`, `0015-prefer-thin-handlers-over-reducer-indirection.md`, `0016-persist-slack-sweep-watermark.md`, `0017-shared-sync-backend-for-pins-and-history.md`, `0018-dedicated-notification-capture-tab.md`, `0019-teams-chat-app.md`.

---

## Keeping docs alive — the practices

### 1. Same-commit doc updates

When a commit changes behavior visible to a reader of the docs, the relevant doc updates in that same commit. If a contract changes and the area `CLAUDE.md` doesn't, the PR fails review.

### 2. The "5-minute briefing" test

Periodically (start of a new feature, or when docs feel stale), open the relevant `CLAUDE.md` and ask: *if I gave this to someone who has never seen the code, could they orient in 5 minutes?* If no, fix the doc.

### 3. Date-stamp staleness

Add a footer to docs that age:

```
_Last revisited: 2026-05-23_
```

When you next read it, if the date is months old and the content still feels right, bump the date. If anything is wrong, fix it then bump.

### 4. Fresh, not patched

When you update a doc, **rewrite the affected section** rather than appending corrections. Docs read as the current truth, not as a sediment of edits.

**Bad:**

```markdown
The main process manages one active WebSocket.

> **Note (2026-01):** Actually as of Edge 148, there can be multiple sockets per target.
```

**Good:**

```markdown
The main process manages one screencast WebSocket (the Remote Page) plus optional
read-only Notification Side-Channel sockets. Multiple concurrent clients per target
are permitted on Edge 148 (Chromium 148) — see ADR-0003.
```

The only place layered amendments belong is ADRs. Everywhere else: rewrite the section.

### 5. Stale-doc bankruptcy is OK

If a doc has rotted beyond repair, delete it and write a fresh one. A wrong doc is worse than no doc — it confidently misleads. ADRs are the only append-only exception.

---

## Anti-patterns

- **"I'll write the docs at the end of the task."** Docs that ship with the code stay accurate; docs written later are already stale.
- **"This change is too small to update docs."** If it changes behavior visible to a reader, it isn't too small.
- **"The code is self-documenting."** Code documents *what*. CLAUDE.md and ADRs document *why*. They're different audiences.
- **"There's an ADR but I changed the decision in code."** The ADR is now a lie. Either update the code to match the ADR, or write a new ADR superseding it.
- **Bolting "Note: …" on top of "Note: …" in a doc.** Stop and rewrite the section.

---

_Docs you don't maintain are a liability. Docs you maintain are a force multiplier._

_Last revisited: 2026-07-07_
