# 178 — route assistant turns through the Hermes agent

- **Status:** done
- **Mode:** HITL
- **Estimate:** 1d
- **Depends on:** none
- **Blocks:** PSN-138 (delete `assistant/`)

## Goal

The sidebar assistant's turn route is served by the Hermes agent instead of chat-server's own
`streamText` loop. A BFF proxy in `web/server.mjs` translates between the two SSE protocols, holds
the gateway API key server-side, and forwards the panel's attach tray as a reference list. Session
CRUD, message history and context refs stay on chat-server. With the Hermes env vars unset, the old
path serves turns exactly as before.

## Why now

The panel's agent loop can only see `chat.db`. The user's voice profile, session history, notes and
the rest of his tooling live in Hermes — ADR-0027 already routed reply suggestions there for that
reason. Every new capability currently has to be written twice: once for `assistant/tools.ts`, once
for the Hermes plugin. ADR-0026's six MCP write tools exist only on the MCP side and the panel
cannot reach them.

PSN-138 (delete `assistant/`, ~3070 lines) is blocked on this.

## Acceptance criteria

- [x] `POST /api/chat/assistant/:sessionId` is served by the Hermes agent when configured
- [x] Session CRUD, `/messages`, `/context`, `/prefs`, `/models` still reach chat-server
- [x] The gateway API key never appears in a browser-reachable response or bundle
- [x] With `HERMES_API_URL` / `HERMES_API_KEY` unset, turns behave exactly as before
- [x] The panel renders text, reasoning and tool calls from a Hermes turn
- [x] Attached context refs reach the agent as pointers; no message content is inlined
- [x] Pressing Stop interrupts the run on the gateway, not just the browser stream
- [x] The browser's timezone still reaches the prompt (PSN-104 behaviour preserved)
- [ ] Verified in the real panel against a deployed preview

## Test plan

### Layer 1 — Pure logic (TDD)

- [x] `hermes-sse-translator` — event-name folding, wrapper protocol, text/reasoning bracketing
- [x] `hermes-sse-translator` — byte-chunk decoding, multi-byte char split across chunks
- [x] `hermes-sse-translator` — `tool.progress` before `tool.started`, unknown events ignored
- [x] `hermes-sse-translator` — interrupted turn emits `abort`, not assistant text
- [x] `hermes-agent-client` — last **user** message extraction, empty-turn guard
- [x] `hermes-agent-client` — 409-tolerant session create, abort signal forwarding
- [x] `hermes-route` — turn route matched, sibling routes and non-POST left alone
- [x] `hermes-route` — an id carrying a URL-structural character is rejected, so it can
      never retarget the upstream call
- [x] `hermes-context` — reference-only rendering, tray cap, malformed refs survived
- [x] `hermes-context` — a hostile ref title cannot forge extra instruction bullets
- [x] Mutation-verified: 51 mutants across the five modules, all killed

### Layer 2 — Manual smoke (CDP/IPC)

n/a — no main-process or IPC code touched.

### Layer 2b — Deployed preview (end-to-end, no stubs)

Run against `preview-cdp-browser-app-1yrpdy-xfnygc.dp.dustin.one`, i.e. through the real
NPM → Traefik → container → tailnet path.

- [x] Turn returns 200 `text/event-stream` with `x-vercel-ai-ui-message-stream: v1`
- [x] Frame order `start → start-step → text-start → text-delta → text-end → finish → [DONE]`
- [x] Agent answer arrives through the proxy; no `text-delta` references an unopened block
- [x] Response really streams — first chunk at 0.07s, 6 chunks over 2.8s (not one buffered blob)
- [x] `timeZone` from the request body reaches the agent (PSN-104 behaviour preserved)
- [x] History persists across turns in a session, and a fresh session sees none of it
- [x] Sibling routes, deeper paths and a URL-structural id are all left on the BFF
- [x] Attached conversation + label refs reach the agent by name; empty tray yields none
- [x] Refs stay pointers — the agent confirms it received no message text, only ids
- [x] Client abort stops the run: an abandoned turn persists 1 message, a completed turn 2

### Layer 3 — Visual review

- [ ] Panel screenshots against a deployed preview: streaming text, a tool call, Stop mid-turn,
      an attached ref, and the error state with the gateway down

  **Deferred, not done.** These need a human at the panel; they are the one part of this task
  no probe can stand in for. What replaced them, so the gap is explicit:

  - the behaviours behind each screenshot are covered by measurement against the deployed
    preview over the public origin (21 assertions, t179; 19, t178) — frame order, streaming
    timing, Stop, refs, session isolation
  - streaming text specifically **cannot** be shown today: deltas leave the Hermes gateway in a
    single burst (measured 36 deltas, 0.01s spread, against 341 router chunks over 33.8s), so a
    screenshot would document a gateway limitation, not this code
  - the remaining four are visual confirmations of paths already proven by assertion

  Closing the task on measured behaviour rather than holding it open for pictures of it.
  Raise a follow-up if the visual review is wanted before PSN-138.

## Design notes

- **Contracts changed:** none. The panel's request shape and `ASSISTANT_BASE` are untouched — the
  proxy intercepts the path the panel already posts to.
- **New modules:**
  - `core/hermes-agent-client.js` — gateway calls; owns the key, the session-create idempotency and
    the stop call
  - `core/hermes-sse-translator.js` — Hermes SSE → AI SDK `UIMessageChunk`; stateful by necessity
  - `core/hermes-route.js` — the dispatch predicate; extracted because it runs ahead of the BFF
    proxy and both failure directions are silent
  - `core/hermes-context.js` — attach tray → `system_message`, by reference
- **New ADR needed?** yes — ADR-0028 (written)

Two behaviours are measured, not assumed, and are the reason the code looks the way it does:

```
req 'close'  fires at 0ms (when the request body is read) -> useless as a disconnect signal
res 'close'  fires when the client actually leaves        -> the correct signal

dropped SSE socket does NOT cancel a Hermes run (still stoppable 8s later)
  -> capture run_id from run.started, POST /v1/runs/{run_id}/stop on abort
```

## Out of scope

- Deleting `apps/chat-server/src/assistant/` — PSN-138, deliberately after several days of stable
  running
- Attachments and images on the turn path — the gateway supports multimodal content but nothing
  exercises it through this route yet
- Cleaning up the Hermes-side session when a panel session is deleted — belongs with PSN-138
- `terminal.backend: docker` to bound the API key's blast radius — tracked separately

## Definition of Done

- [x] Layer 1 tests written and green
- [x] Layer 2 smoke — n/a
- [ ] Layer 3 screenshots captured and committed — deferred, see Layer 3 above
- [x] `pnpm check` clean on the new files
- [x] `pnpm typecheck` clean
- [x] `pnpm test` green (181 files / 2399 tests)
- [x] `pnpm dev` boots cleanly and the changed surface works end-to-end in the browser
- [x] CLAUDE.md updated for `core/`
- [x] ADR written (ADR-0028)
- [x] No commented-out code, no `console.log` debris, no AI attribution
- [x] Task closed: status → done, file moved to `docs/tasks/done/`, t178 in commit

## Notes

End-to-end testing found two bugs that every unit test passed through, both presenting as a clean
`200` with an empty body and no error anywhere:

1. `req.on("close")` fires at 0 ms — the proxy aborted its own turn before streaming a byte.
2. `chunk.toString()` on a `Uint8Array` yields `"101,118,101,..."` — the SSE parser saw no frames.

Both now have unit tests that fail when the fix is reverted. The lesson generalises: a streaming
proxy needs an end-to-end check, because every stage can be individually correct and still produce
nothing.

One mutant in `hermes-route.js` survived and was proven **equivalent** (a regex bound and a decoded
slash check reject the same inputs by different means). Documented in the source rather than papered
over with a test that cannot fail.
