# PSN-114 — [chat] Expose chats as MCP server

Plan-only until the label flips to `build`. Same issue, same branch (`chat-expose-chats-as-mcp-server`), ONE PR.

## Goal

A coding agent (Claude Code, any MCP client) connects to the running chat BFF and **reads the user's own synced chat history** — search messages, read a thread, list conversations, resolve people, see unread, look at an inline image. Read-only by construction; no send/react/edit surface. This makes `chat.db` addressable from the agent the operator already lives in, reusing the AI assistant's proven retrieval layer verbatim.

The ask also says "research custom MCP servers to propose enhancements and better ideas" — the world-class additions over a bare tool list: **resources** (addressable by URI, the agent can browse/reference chats) and **prompts** (canned templates). Live change-notification is deferred.

Constraints (from the issue): self-chat only, no mutations on other users' threads. Read-only satisfies this trivially.

## End-to-end local testing strategy

No vision needed — the MCP server has no UI. Correctness = the MCP wire contract + data fidelity. Four layers, bottom-up. **L1–L3 are hermetic and run in `pnpm test` (CI); L4 is HITL** (a real agent turn no CI can close).

**Testability shape (load-bearing):** `mcp.ts` exports `createMcpServer({ db, service, vision }) → McpServer` AND a thin `mountMcp(app, { db, service, vision })` Hono route, **independent of `index.ts`'s full boot** (no sweep/captioner/WS-hub timers). L2/L3 tests build a minimal Hono app with just `mountMcp` on an ephemeral port + a mock provider + `:memory:` db, so the MCP surface is testable in isolation. The captioner is only needed for `view_image`'s caption fallback — stub `vision` in tests.

### L1 — Unit (pure, TDD)
`apps/chat-server/src/mcp.test.ts`, `:memory:` db + the mock provider's fixtures. Each tool/resource/prompt registered with the right zod schema; each `execute` returns the expected shape for a seeded hit and a miss. `view_image` with a stub `vision.fetchImage` → MCP image content; bytes-unavailable → caption fallback. These are the WS-A/B unit tests.

### L2 — Protocol contract (raw JSON-RPC over HTTP, no SDK client)
Boot the minimal app (`mountMcp` only) on an ephemeral port with `CHAT_PROVIDER=mock` + `:memory:` db; assert the wire contract with raw `fetch` POSTs:
- `initialize` → `InitializeResponse`; **no `Mcp-Session-Id`** header (stateless, D1/D8); a second `initialize` without `DELETE` works.
- `MCP-Protocol-Version` header accepted; missing → server assumes `2025-03-26` (spec).
- `tools/list` → 8; `resources/list` → 2 + the URI template; `prompts/list` → 3.
- `tools/call search_messages` → fixture hits; `resources/read chat://conversations` + `chat://conversation/{id}` → seeded data; `prompts/get` each → seeded guidance.
- **Security gate:** non-localhost `Origin` (`Origin: https://evil.example`) → 4xx (DNS-rebinding, D8).
- POST with `Accept` lacking `application/json` + `text/event-stream` → 4xx (spec).

This proves the server speaks correct MCP independent of any client SDK.

### L3 — Programmatic MCP-client e2e (hermetic backbone)
Same minimal app, but connect a **real `@modelcontextprotocol/sdk` client** over streamable HTTP (the client ships in the same package we add in WS-A — free). Exercise every tool against the mock provider's pinned conversations + `richSeed()` (links, @mention, edited msg, tombstone, unread row, muted row, 30-msg paging thread, folder/label prefs via `MOCK_PREFS`):
- `search_messages` finds the @mention (diacritic-fold check too).
- `get_context` walks a reply chain via `aroundMsgId`.
- `list_scopes` + `resolve_scope` return the seeded folder/label.
- `get_unread_overview` returns the unread row, excludes the muted one unless `includeMuted`.
- `view_image` returns image content (or caption fallback per R4).
- `resolve_person` + `list_conversations` return seeded rows.

Real client, real transport, real BFF, real (mock) data — zero network, zero tenant. This is the regression backbone.

### L4 — HITL: real Claude Code turn (manual, not CI)
`pnpm chat:mock` (Node 24, `nvm use 24` for the `better-sqlite3` ABI) → `claude mcp add --transport http chats http://localhost:7810/mcp` → scripted turns against fixtures:
- "what did I miss today" → `get_unread_overview`.
- "summarize <conversation>" → `get_context`.
- "find the decision about X" → `search_messages`.
- "what's in the screenshot in <msg>" → `view_image`.
- Inject mid-turn: `pnpm chat:mock:say -d '{"convId":"…","text":"…"}'` then re-ask → agent sees the new message (live-data proof, mirrors the chat-qa mock-say pattern).

Assert the agent cites real `(convId,msgId)` from fixtures. **Capture the served commit first** (preview deploys lag pushes — verify the served commit before debugging "still broken"). A human/agent closes this; it is the "does a real agent actually work" gate.

### Regression dispatch
Extend `docs/testing/chat-qa.md` with MCP case IDs covering L2/L3/L4 (the `/regression` skill fans these to subagents like the existing chat surface). **Extended, never rewritten.** `/regression` verdict-only, evidence on disk.

### Mock-stack caveats (from CLAUDE.md)
- Node 24 for `better-sqlite3` ABI (`nvm use 24`).
- Mock DB starts empty — seed before calling a feature missing.
- `pnpm chat:mock:say` is the inbound simulator (PSN-106) — use it for live-data turns.
- **R4:** confirm `MockProvider.media()` serves image bytes; if not, add a small fixture so L3 `view_image` covers the image-content path, not just caption fallback.

### Gates
`pnpm test` (chat-server scope — L1+L2+L3 hermetic), `pnpm typecheck`, `pnpm check:changed` clean in CI. L4 is the operator's manual pass before merge.

## Baseline (probed 2026-07-28)

- **`apps/chat-server`** = Hono + better-sqlite3 BFF on `:7810` (`pnpm chat:bff`), owns `chat.db` (service-agnostic schema, Teams-only today). No auth — plaintext localhost, reverse-proxied by `web/server.mjs` at `/api/chat/*`. Boots in `src/index.ts`; the raw `http.Server` comes from `@hono/node-server`'s `serve()`.
- **A proven read-only retrieval layer already exists** for the in-app AI assistant (`src/assistant/loop.ts`): 8 zod tools — `search_messages`, `get_context`, `list_conversations`, `list_scopes`, `resolve_scope`, `resolve_person`, `get_unread_overview`, `view_image` — over pure fns in `src/search.ts` (FTS5, Vietnamese-fold, reply-chain split, scopes) + `src/unread-overview.ts`. Strictly read-only by design ("no send/react/edit tool exists, so the loop cannot mutate"). Every row is stamped `(convId, msgId)`.
- **`view_image` in the assistant** reuses the BFF's vision wiring (in `index.ts`): `fetchImage(objectId)` → `provider.media(url)` + `downscaleImage` → bytes. The assistant then buffers pixels and re-injects as a `role:"user"` part next step — an **ai-sdk-specific hack** (`@ai-sdk/openai-compatible` drops image content from tool results). MCP has no such limit: image content is a native tool-result content type.
- **No MCP SDK** in the repo today. `package.json` has `ai`, `hono`, `better-sqlite3`, `zod` — no `@modelcontextprotocol/sdk`.
- **Mock provider** (`src/providers/mock-provider.ts`) backs `pnpm chat:mock`; its `.media()` path needs confirming for `view_image` (R4).
- Probe `100.85.206.8:9222` = the CDP/Teams keeper tab (cred source), **not** the BFF. Out of scope: the MCP server reads `chat.db`, never Teams directly.

## Decisions (grilled 2026-07-28)

- **D1 — Transport = Streamable HTTP on the BFF.** A single `/mcp` endpoint on the running `:7810` server (POST + GET per spec, stateless — no `Mcp-Session-Id`). Chosen over stdio because it reuses the live BFF: always-fresh data, the running captioner, and the real image-fetch path for `view_image` with zero second-process DB plumbing. Claude Code connects via `claude mcp add --transport http chats http://localhost:7810/mcp`.
- **D2 — Read-only.** No write tools. Constraint ("self-chat only, no mutations") satisfied by construction. Mirrors the assistant's stance exactly.
- **D3 — Reach = localhost, no auth.** `/mcp` mounts on `:7810` only; **not** reverse-proxied through `web/server.mjs`, so it never reaches the public origin. No token — matches the rest of the BFF's localhost posture. Remote access rides Tailscale (the operator's existing setup), which handles transport security; a bearer token is a later hardening only if exposed beyond the tailnet.
- **D4 — All 8 retrieval tools.** Mirror the assistant's set verbatim: `search_messages`, `get_context`, `list_conversations`, `list_scopes`, `resolve_scope`, `resolve_person`, `get_unread_overview`, `view_image`. Same schemas, same pure-fn bodies. `view_image` returns **native MCP image content** (`{ type:"image", data:base64, mimeType }`) in the tool result — no ai-sdk buffer hack. The citation-validation layer (assistant-UI concern) is dropped, but `(convId,msgId)` stamping on every row stays so the agent can reference messages.
- **D5 — Resources + prompts.** Two MCP resources: `chat://conversations` (the conversation list) and `chat://conversation/{id}` (recent messages of one thread via `getContextWindow`). Three prompts: `catch-up-on-unread`, `summarize-conversation`, `find-decision` — thin prompt templates over the existing tools.
- **D6 — Single-service.** The registered provider's `service` only (the assistant's `assistantService` — `teams` in prod, the mock id under `pnpm chat:mock`). No `service` parameter on tools. Multi-service is additive the day a second provider ships (YAGNI now).
- **D7 — In-process packaging.** New module `apps/chat-server/src/mcp.ts` + `@modelcontextprotocol/sdk` dep, mounted on the **existing** Hono app in `index.ts`. Shares the BFF's already-open `db` handle — no second connection, zero concurrency concern. Not a new package, not a new process.
- **D8 — Security hardening per spec.** Validate the `Origin` header on every `/mcp` request (reject non-localhost) and confirm the BFF binds `127.0.0.1` (enforce if `@hono/node-server` defaults wider). Stateless = no session-fixation surface.
- **D9 — The AI assistant is NOT refactored onto MCP.** Two adapters (assistant's `loop.ts` over the `ai` SDK; the new `mcp.ts` over the MCP SDK), both calling the *same* pure fns in `search.ts`/`unread-overview.ts` — which is already the shared 90%. The remaining ~100-line wrapper duplication is justified because the adapters diverge at real, load-bearing boundaries: (a) the assistant's `onSurfaced` builds the citation allow-set (chip validation), which MCP has no hook for; (b) `view_image` in the assistant uses an ai-sdk-specific image-buffer hack (pixels re-injected as a `role:"user"` part next step, because `@ai-sdk/openai-compatible` drops image content from tool results), whereas MCP returns image content natively in the tool result — routing the assistant through MCP would **break `view_image` and lose citations**; (c) the assistant is co-located in the same process, so a JSON-RPC+HTTP loopback per streamed tool call is pure overhead with no functional gain. A shared neutral "tool manifest" is deferred until a third consumer appears (CLI client, bot) — premature with two. Revisit only if the assistant moves to a separate process, at which point `@ai-sdk/mcp` against this server becomes the canonical tool surface.

## Workstreams

Each is one session. Same branch, same PR throughout. Bug-sweep last.

### A — MCP server scaffold + 8 tools
**Touches:** `apps/chat-server/package.json` (dep), `apps/chat-server/src/mcp.ts` (new), `apps/chat-server/src/index.ts` (mount), `apps/chat-server/src/mcp.test.ts` (new).
- **A.0 (research, no code):** `pnpm add @modelcontextprotocol/sdk` in `apps/chat-server`, then read the installed `StreamableHTTPServerTransport` + `McpServer` types to confirm the exact Hono bridge: a `/mcp` catch-all whose handler builds a web `Request`/`Response` bridge to the transport (stateless mode, `sessionIdGenerator: undefined`). Verify against installed types, not memory.
- **A.1 `createMcpServer({ db, service, vision })` → `McpServer`:** register the 8 tools. Each tool's `execute` calls the *same pure fn* the assistant uses (`searchMessages`, `getContextWindow`, `listConversationsByQuery`, `listScopes`, `resolveScope`, `resolvePerson`, `getUnreadOverview`, and `view_image` → `listMessageImages` + `vision.fetchImage`). Schemas copied from `loop.ts`. Tool-result rows shaped exactly like the assistant's (`convId,msgId,sender,ts,…`).
- **A.2 `view_image`:** return MCP image content `{ type:"image", data, mimeType }` from the fetched/downscaled bytes; fall back to the transcription (`caption`) when bytes are unavailable, mirroring the assistant's honest fallback.
- **A.3 Mount:** `mcp.ts` exports `createMcpServer({ db, service, vision }) → McpServer` and a thin `mountMcp(app, …)` Hono route at `/mcp` (with the `Origin` check), **decoupled from `index.ts`'s full boot** so L2/L3 tests mount it alone on an ephemeral port. In `index.ts`, call `mountMcp(app, { db, service: assistantService, vision: <assistant's existing fetchImage/downscale wiring> })` — reuse the `assistantService` + `assistantProvider` + `assistantCaptioner` already resolved there.
- **Tests:** `mcp.test.ts` against `:memory:` db + mock fixtures — each tool registered, schema correct, `execute` returns expected shape for a seeded hit/miss. `view_image` covered with a stub `vision.fetchImage`.
- **Verify:** `curl POST /mcp` initialize + `tools/list` (12 entries after B; 8 here) + `tools/call search_messages` against `pnpm chat:mock` returns fixture hits. `Origin: https://evil.example` → 4xx.

### B — Resources + prompts
**Touches:** `apps/chat-server/src/mcp.ts`, `apps/chat-server/src/mcp.test.ts`.
- **B.1 Resources:** `chat://conversations` (a static template listing conversations via `listConversationsByQuery({})`) and a URI-template resource `chat://conversation/{convId}` returning recent messages (`getContextWindow({ convId })`). Register the list + the template handler.
- **B.2 Prompts:** `catch-up-on-unread` (seeds a "what did I miss" turn over `get_unread_overview`), `summarize-conversation` (takes `convId`, points at `get_context`), `find-decision` (search prompts for decision/decided/agreed + time guidance). Each returns a prompt with the retrieval tool calls pre-seeded as guidance text.
- **Tests:** resources/templates resolve for a seeded db; prompts return the expected messages.
- **Verify:** `resources/list` + `resources/read`, `prompts/list` + `prompts/get` over the mock stack.
- Depends on A (same server object).

### C — Docs + bug-sweep + manual agent turn
**Touches:** `docs/adr/0023-*` (new), `CLAUDE.md` (Teams-chat-app bullet), `docs/guides/chat-mcp.md` (new, the `claude mcp add` snippet), `docs/testing/chat-qa.md` (extended with MCP case IDs — extended, never rewritten).
- **C.1 ADR-0023:** the MCP-server decision (HTTP on BFF, read-only, single-service, resources+prompts, security posture). Append-only, per `docs/conventions/docs-discipline.md`.
- **C.2 CLAUDE.md:** one bullet under the "Teams chat app" block — the `/mcp` endpoint, what it exposes, the `claude mcp add` one-liner, the localhost/no-auth stance.
- **C.3 Guide:** `docs/guides/chat-mcp.md` — connect Claude Code to the local BFF, the tool/resource/prompt catalog, the mock-stack quickstart.
- **C.4 Manual end-to-end (L4):** `pnpm chat:mock`, `claude mcp add --transport http chats http://localhost:7810/mcp`, run the scripted turns (summarize unread / find decision / view screenshot) against fixtures — assert the agent retrieves real rows and cites `(convId,msgId)`. Capture served commit first.
- **C.5 Bug-sweep:** re-read the diff; confirm no orphan imports, no drift from `loop.ts` schemas, the `/` build is byte-unchanged.
- Depends on A + B.

## Dependency / parallelism

| WS | Depends on | Parallel? |
|---|---|---|
| A (scaffold + 8 tools) | — | — |
| B (resources + prompts) | A | after A (same `mcp.ts`) |
| C (docs + sweep + manual) | A + B | last |

Linear: A → B → C. Each is one session; none overlap (all touch `mcp.ts`).

## Acceptance checklist

- [ ] BFF boots; `POST /mcp` returns a spec-correct `InitializeResponse` (stateless, no `Mcp-Session-Id`).
- [ ] `tools/list` returns the 8 tools; `resources/list` returns the 2 resources (+ template); `prompts/list` returns the 3 prompts.
- [ ] **L1 unit:** each tool/resource/prompt registered with correct schema + execute shape (`:memory:` + fixtures).
- [ ] **L2 contract:** raw-JSON-RPC initialize/list/call + stateless assertion + `Accept` validation pass; non-localhost `Origin` → 4xx.
- [ ] **L3 client e2e:** a real MCP client over HTTP exercises every tool against `richSeed()` fixtures (search, reply-chain walk, scopes, unread excl. muted, view_image, person, list).
- [ ] `view_image` returns MCP image content when bytes resolve, transcription fallback otherwise.
- [ ] BFF binds `127.0.0.1` (verified or enforced).
- [ ] **L4 HITL:** a real Claude Code turn over `pnpm chat:mock` retrieves rows + cites real `(convId,msgId)`; `chat:mock:say` mid-turn is seen live.
- [ ] `pnpm test` / `typecheck` / `check:changed` clean (chat-server scope).
- [ ] `docs/testing/chat-qa.md` extended with MCP case IDs (L2/L3/L4).
- [ ] ADR-0023 + CLAUDE.md bullet + `docs/guides/chat-mcp.md` shipped.
- [ ] `/` build byte-unchanged.

## Risks

- **R1 — SDK ↔ Hono bridge signature.** The exact `StreamableHTTPServerTransport` web-`Request`/`Response` bridge vs raw `http.IncomingMessage` varies across SDK versions. A.0 reads the installed types before writing the handler — no assumption.
- **R2 — `view_image` image-content shape.** MCP image content is `{ type:"image", data:base64, mimeType }`. Confirm against the SDK's `ImageContent` type in A.2; the assistant's ai-sdk buffer hack is explicitly NOT carried over.
- **R3 — BFF bind width.** `@hono/node-server` may bind `0.0.0.0`. Verify in A.3 and force `127.0.0.1` for the `/mcp` path (or the whole server) if so — the spec mandates localhost for local MCP servers.
- **R4 — Mock provider media.** `view_image` needs bytes; if `MockProvider.media()` doesn't serve image fixtures, the live mock test degrades to the transcription fallback (still covered by a unit test with a stub). Confirm in B/verify; add a fixture if cheap.

## Out of scope

- Live resource change-notifications (WS-hub deltas → MCP resource updates). Follow-up.
- Multi-service support (a second provider). YAGNI.
- Bearer-token auth + public reverse-proxy. Tailscale covers remote; token only if exposed beyond the tailnet.
- A stdio transport. HTTP-only per D1.
- Any write tool (send/react/edit/mark-read). Read-only per D2 + the issue constraint.
- Routing the AI assistant onto MCP (D9). The assistant keeps its own `ai`-SDK tool definitions; the two share the pure `search.ts` fns, not the protocol surface. Revisit at a third consumer or if the assistant moves out-of-process.
