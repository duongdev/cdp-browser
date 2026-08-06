# ADR-0028: The assistant panel runs on the Hermes agent, via a BFF proxy

- **Status:** Accepted
- **Date:** 2026-08-05
- **Issue:** PSN-133, PSN-134
- **Relates to:** ADR-0021 (agentic retrieval), ADR-0024/0025 (MCP server, tailnet), ADR-0027 (reply suggestions)

## Context

The sidebar assistant runs its own agent loop in `apps/chat-server/src/assistant/` — 2355 lines of
`streamText` orchestration, tool definitions, compaction and prompt building, plus `llm.ts` (293
lines) and the client-side `assistant-*.ts` (422 lines).

That loop is capable but it is an island. It has `chat.db` and a model client, and nothing else. The
user's voice profile, his session history, his Linear board, his notes, the rest of his tooling all
live in Hermes. ADR-0027 already reached this conclusion for reply suggestions and routed them to
the Hermes agent for exactly this reason. The panel is the larger surface with the same problem.

Running two agent loops against the same chat data also means every capability is built twice. A new
tool has to be written once for `assistant/tools.ts` and once for the Hermes plugin. ADR-0026's six
MCP write tools exist only on the MCP side; the panel cannot use them.

PSN-138 already schedules `assistant/` for deletion. This ADR is what makes that deletion possible.

## Decision

**The turn route — and only the turn route — is served by the Hermes agent, through a proxy in
`web/server.mjs`.**

`POST /api/chat/assistant/:sessionId` diverts to Hermes. Everything else on that prefix — session
CRUD, message history, context refs, prefs, model list — continues to chat-server unchanged.

### 1. A proxy, not a browser-to-gateway call

The gateway API key never reaches the browser. Hermes's terminal tool runs unsandboxed as the host
user, so a key in a tab is a shell on the host handed to any script running in that page. The key
lives in `web/server.mjs` only, read from `HERMES_API_KEY`.

This also keeps the panel unchanged. It already posts to `${ASSISTANT_BASE}/${sessionId}`; the
proxy intercepts that exact path. No client code was touched.

### 2. A stateful translator, not a pass-through

The two SSE protocols are not compatible. Hermes puts the event type **only** in the `event:` line;
AI SDK's `useChat` parses with `EventSourceParserStream`, which reads `data:` and ignores `event:`.
Piping bytes through loses every type. AI SDK additionally requires `start`/`start-step` wrappers
and `text-start`/`text-end` bracketing that Hermes has no equivalent for.

`core/hermes-sse-translator.js` folds the event name into the payload and holds the wrapper state.
The mapping was measured against a live gateway, not inferred (`docs/memories/hermes-sse-contract.md`).

### 3. Opt-in, with the old path as the fallback

With `HERMES_API_URL` or `HERMES_API_KEY` unset, the proxy does not install itself and the BFF
serves turns exactly as before. A missing env var is a clean fallback, not an outage — and it is
what makes PSN-138's deletion safe to defer until the new path has run for a few days.

### 4. Session ids are reused, not mapped

Hermes accepts a client-chosen session id on create (verified: 201 for a uuid-shaped id, 409 on a
repeat, 404 for an unknown one). The panel's own session id is passed straight through, so there is
no id-mapping table to build, persist, or resynchronise after a restart.

The proxy calls create on every turn and treats 409 as success. A pre-flight GET would add a
round-trip to every turn to answer a question that only matters once per session.

### 5. Context refs travel as `system_message`, by reference

The attach tray lives in chat-server's DB and Hermes has never heard of it. The proxy reads it and
passes a **list of pointers** — convIds, msgIds, folder and label names — never the content. The
agent fetches real messages through `/mcp` (ADR-0021, ADR-0024).

Inlining excerpts was rejected for the reason ADR-0027 already documents: a copied excerpt bakes a
stale snapshot into the prompt that un-attaching can never retract. It would also blow the context
window on a large tray. The list is capped at 40 items with a "…and N more" tail.

### 6. Client abort is forwarded explicitly

A dropped SSE socket does **not** cancel a Hermes turn — measured: the run was still stoppable 8
seconds after the client vanished. Without forwarding, pressing Stop closes the browser stream while
the agent keeps running tools and spending tokens invisibly.

The proxy captures `run_id` from the `run.started` frame and posts `/v1/runs/{run_id}/stop` when the
response closes. Note **response**, not request: Node fires request-`close` as soon as the request
body is read — measured at 0 ms, before any response byte — so watching the request aborts the
proxy's own turn instantly.

## Consequences

**Gained.** One agent loop instead of two. The panel inherits every Hermes capability — memory,
session history, the full toolset, the MCP write tools from ADR-0026 — without any of it being
ported. PSN-138 can now delete ~3070 lines.

**Cost.** A network hop from chat-server's host to the gateway, over the tailnet. The gateway is a
new hard dependency for the panel: when Hermes is down, turns fail with `hermes_unreachable` rather
than degrading. Session CRUD and history keep working, so the panel still opens and reads.

**Security.** `web/server.mjs` now holds a credential that grants shell access to the host user.
That raises the blast radius of any bug in this server from "chat data" to "host compromise".
`terminal.backend: docker` on the Hermes side would bound it; that is not decided and is tracked
separately.

**Duplicated state.** Two session stores now describe the same conversation: chat-server's
`ai_sessions` (title, refs, message history for the UI) and Hermes's own (the agent's transcript).
They are keyed by the same id but neither is authoritative for the other. Deleting a session in the
panel leaves the Hermes session behind. Accepted for now; a cleanup call belongs with PSN-138.

**Not addressed.** Attachments and images on the turn path are untested against this route —
`_normalize_multimodal_content` exists on the gateway but nothing exercises it here yet.
