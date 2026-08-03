# ADR-0024: Chat read-only MCP server

- **Status:** Accepted — decision 6 (security posture) amended by ADR-0025; decision 3 (read-only) amended by ADR-0026
- **Date:** 2026-07-30

## Context

PSN-114 asks for a way for a local coding agent (Claude Code, any MCP client) to query the user's
own synced chat history — the same data the in-app AI assistant (PSN-104, ADR-0021) and the global
search (PSN-115, ADR-0023) already read. The chat BFF (`apps/chat-server`) owns `chat.db`; the
proven retrieval surface already exists as pure functions in `search.ts` / `unread-overview.ts` and a
hybrid data plane in `assistant/search-fallback.ts` (local FTS + Substrate fallback + hydrate).

The question was how to expose that surface to an external agent without duplicating the data plane
or breaking the assistant's ai-SDK-specific behavior (citation tracking, the image-buffer hack).

## Decision

Expose a **read-only MCP server** at `POST/GET /mcp` on the running chat BFF, using the MCP
**Streamable HTTP** transport in **stateless** mode (`WebStandardStreamableHTTPServerTransport` with
no `sessionIdGenerator`). A local coding agent connects with
`claude mcp add --transport http chats http://localhost:7810/mcp`.

1. **Same data plane, separate adapter (D9).** The MCP server is a second thin adapter over the same
   pure functions + the shared `runSearch` orchestration. The in-app assistant keeps its own ai-SDK
   `tool()` definitions — they carry `onSurfaced` citation validation and the image-buffer hack
   (pixels re-injected as a `role:"user"` part next step, because `@ai-sdk/openai-compatible` drops
   image content from tool results). MCP returns image content natively in the tool result and has no
   citation layer; the two adapters diverge at those consumer boundaries. They share the 90% that
   matters — the retrieval logic + the hybrid search orchestration (`assistant/search-fallback.ts`,
   extracted for this ADR so both call one `runSearch`).

2. **Reuse PSN-115's hybrid search (D10).** `search_messages` calls the same `runSearch` the
   assistant uses — local FTS fast path, then Substrate live fallback + hydrate-on-miss — so an MCP
   query reaches **all** Teams history, not just the synced `chat.db` subset. Sequencing: PSN-115's
   search seam landed first; this issue points the MCP tool at it.

3. **Read-only.** No send/react/edit/mark-read tool. The issue's constraint ("self-chat only, no
   mutations on other users' threads") holds by construction.

4. **Tools + resources + prompts.** Eight tools (the assistant's set), two resources
   (`chat://conversations`, `chat://conversation/{convId}`), three prompt templates
   (`catch-up-on-unread`, `summarize-conversation`, `find-decision`). Live change-notifications are
   out of scope.

5. **Single-service, in-process.** Mounted on the existing Hono app in `apps/chat-server/src/index.ts`
   via `mountMcp`, sharing the BFF's already-open `db` handle + the assistant's `vision` +
   `search` deps. Not a new package, not a new process. The `@modelcontextprotocol/sdk` dep is
   chat-server-only (not in the Electron `build.files` allowlist).

6. **Security posture (D3/D8).** Localhost-only, no auth — matches the rest of the BFF, which is
   plaintext-no-auth behind `web/server.mjs`'s reverse proxy. `/mcp` is **not** reverse-proxied to
   the public origin, so it never leaves the host. Remote access rides the operator's Tailscale.
   A per-request `Origin` header check (allow absent + localhost, reject everything else) closes the
   MCP-spec DNS-rebinding vector. Per the SDK's own stateless example, each request builds a **fresh
   `McpServer` + transport** — reusing either across requests corrupts internal state / causes
   message-id collisions.

## Consequences

- **+** An external coding agent reads chat history through the same battle-tested path the
  assistant + global search use; no second retrieval implementation.
- **+** The `runSearch` extraction (D10) removed ~80 lines of inlined orchestration from
  `assistant/loop.ts`; the assistant and MCP now share one data plane, so the two can't drift.
- **−** Two thin adapters over the shared core (~100 lines each). Acceptable: the divergence is real
  (ai-SDK vs MCP return shapes; citations; image handling). A shared neutral "tool manifest" is
  deferred until a third consumer appears — premature with two.
- **−** Stateless = a fresh `McpServer` per request. Cheap (registration only, no I/O), but it is
  per-request work a stateful session would amortise. Stateless was chosen for simplicity + the
  localhost single-user case; revisitable if a multi-client deployment needs sessions.
- **−** `/mcp` is only as complete as `chat.db` + Substrate reach; PSN-115's hydrate is bounded, so
  substrate-only rows ship as previews (`substrate:true`). The MCP tool description says so.
