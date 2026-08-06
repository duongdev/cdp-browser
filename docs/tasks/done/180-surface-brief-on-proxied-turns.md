# 180 — tell the proxied agent what surface it is answering on

- **Status:** done
- **Mode:** HITL
- **Estimate:** 0.25d
- **Depends on:** t178, t179
- **Blocks:** —

## Goal

An agent answering in the assistant panel knows where it is: docked beside the user's Teams
conversations, holding read-only tools over that same data, with no way to send a message.
It reaches for those tools instead of answering from ref titles, and it never offers to send
something on the user's behalf.

## Why now

t178 moved the turn onto Hermes. The BFF assembled its prompt in `apps/chat-server`, next to
the code that knew what the surface was; the proxy carries only the attach tray, so that
description was left behind.

Two consequences, both visible in answers:

- the agent offers to act on messages — "I'll reply to Glory for you" — on a surface with no
  send route at all
- with an empty tray it had no instruction to use its chat tools, so it answered from what it
  could infer instead of reading

The empty-tray case is the common one. The old assembler returned `""` when nothing was
attached and the caller then skipped `system_message` entirely, so most turns carried no
surface description whatsoever.

## Approach

A module constant, `SURFACE_BRIEF` in `core/hermes-context.js`, plus a `buildSystemMessage`
assembler that owns the order: brief, then timezone, then the attach tray. Static text in a
versioned file rather than an env var (ADR-0030 decision 2) — a change to what the agent is
told should read as a diff.

Ordering is a caching constraint. Hermes' per-conversation prompt caching keys on the prefix,
so the fixed brief goes first and the volatile tray last; refs-first would move the prefix on
every attach and miss the cache every turn. The assembler owns it so no caller can invert it.

## Scope

- `core/hermes-context.js` — `SURFACE_BRIEF`, `buildSystemMessage`, `safeLabel` applied to the
  incoming `timeZone`
- `core/hermes-context.test.ts` — brief properties, ordering, prefix stability, empty tray
- `web/server.mjs` — `proxyHermesTurn` calls the assembler instead of joining refs itself
- `docs/adr/0030-surface-brief-on-proxied-turns.md`

Out of scope: streaming. Deltas arrive from the gateway in a single burst — measured at the
router (341 chunks over 33.8s for `glm/glm-4.7`) versus the gateway (36 deltas, 0.01s spread),
so the buffering is upstream of this repo and no change here can fix it.

## Verification

| check | result |
|---|---|
| unit suite | 2469 pass (183 files) |
| mutation, this change | 5/5 unit mutants killed |
| `tsc --noEmit` | clean |
| `node --check web/server.mjs` | clean |
| biome on changed files | clean (45 `noConsole` in `server.mjs` are baseline) |
| deployed preview E2E | see below |

The sixth mutant — blanking `systemMessage` in `server.mjs` — survives the unit suite by
design: nothing units `server.mjs`. It is covered by the preview E2E, which asks the deployed
agent what it can do and checks the answer denies a send path.

## Test cases

Added to `docs/testing/chat-qa.md` section 13 as HA-15..HA-18.
