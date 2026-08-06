# ADR-0030: The proxied turn opens with a fixed description of its own surface

- **Status:** Accepted
- **Date:** 2026-08-06
- **Issue:** t180
- **Relates to:** ADR-0028 (assistant turns on the Hermes agent), ADR-0021 (agentic retrieval)

## Context

A turn proxied to Hermes arrives with the agent's own general-purpose prompt and, when the
user has attached something, a list of context refs. Nothing tells the agent **where it is
running**.

That gap shows up in the answers. The agent does not know it is docked beside the user's
Microsoft Teams window, that its chat tools read the very conversations the user is looking
at, or that this surface has no send path at all. So it does two things it should not:

- offers to act on messages it cannot act on — "I'll reply to Glory for you" — when the
  proxy has no send route and never has
- treats its chat tools as optional, answering from the ref titles instead of reading the
  content they point at, which is the failure ADR-0021 traded inline excerpts to avoid

The BFF path never had this problem: its prompt was assembled in `apps/chat-server` next to
the code that knew what the surface was. Diverting the route left the description behind.

## Decision

**1. A fixed surface brief opens every proxied turn.**

`SURFACE_BRIEF` in `core/hermes-context.js` — a module constant, not a template — states
three things: what the panel is and what the user is looking at, that the chat tools read
that same Teams data and should be used before answering from memory, and that the panel
can only read, so a message never goes out.

**2. It ships with the code, not with configuration.**

Static text in a versioned file (option A). An env var would make the prompt differ between
prod and preview, change without a diff, and be untestable — the exact properties that make
prompt regressions invisible. A change to what the agent is told is a code review.

**3. Order within `system_message` is most-stable-first.**

```
SURFACE_BRIEF     fixed forever
timezone          per user, stable across a session
attach tray       changes whenever the user attaches anything
```

This is a caching constraint, not a stylistic one. Hermes' per-conversation prompt caching
keys on the prefix; putting the volatile tray first would move the prefix on every attach
and miss the cache on every turn. `buildSystemMessage` owns the order so no caller can get
it wrong, and a test asserts the prefix is byte-identical across three different trays.

**4. The brief is sent even when the tray is empty.**

The previous assembler returned `""` for an empty tray and the caller skipped
`system_message` entirely. An empty tray is the common case — most questions are typed
without attaching anything — so the common case was precisely the one where the agent knew
nothing about its surface.

**5. The timezone is flattened like any other untrusted label.**

`timeZone` arrives in the request body and is forgeable by anyone who can POST. It runs
through the same `safeLabel` used for ref titles, for the same reason: a newline in a system
prompt forges an instruction bullet (the hazard fixed in ADR-0028's review).

## Consequences

Every proxied turn carries roughly 700 extra characters of prompt. That cost is paid once
per conversation rather than per turn, because the brief sits in the cached prefix — which
is the whole reason for decision 3.

The brief describes the surface as read-only. If a send path is ever added, this text
becomes false and must change in the same commit; the test asserting the prohibition will
fail first, which is the intended tripwire rather than an obstacle.

The brief is prose, and prose has no compiler. The tests assert properties — that it names
the surface, mentions the tools, denies a send path, and stays free of interpolation — not
its wording, so it can be reworded without a test rewrite but cannot silently lose a claim.
