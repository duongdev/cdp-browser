# ADR-0021: AI assistant — agentic retrieval over chat.db, AI SDK provider seam

- **Status:** Accepted
- **Date:** 2026-07-27

## Context

CDP Chats stores every synced Teams message in the BFF's `chat.db` (ADR-0020) — a complete, local, service-agnostic message corpus. We want an AI assistant inside the chat app that can answer questions over that corpus ("what did X say about the deploy?"), cite the messages it used with deep links into the app, keep persistent sessions across restarts, and accept a referenced chat/message as context ("ask AI about this"). The LLM layer must be provider-pluggable: the first provider is a locally-hosted 9router endpoint (OpenAI-compatible proxy with tiered fallback), with direct Claude/OpenAI later.

Constraints discovered during research (2026-07-27, all verified against primary sources):

- **z.ai GLM Coding Plan is ToS-restricted to official coding tools.** Its usage policy forbids SDK/third-party integrations and enforces via client fingerprinting with a ban ladder. A custom backend must use a sanctioned metered endpoint — or a router the user configures at their own risk. We therefore treat the provider endpoint as pure config, never hardcoding any vendor's coding-plan URL.
- **SQLite FTS5 alone cannot search Vietnamese from ASCII queries.** Empirically verified: `unicode61 remove_diacritics=2` folds tone marks and horn characters (ơ, ư) but NOT đ/Đ — `duong` misses `đường` — because đ is a stroked letter with no combining-mark decomposition. The repo's existing fold logic (`src/lib/fold-text.ts` / `core/history-store.js`) maps đ→d and must be applied at index and query time.
- **Industry converged on agentic retrieval for local structured stores.** Anthropic removed embedding search from Claude Code in favor of iterative lexical search; Cursor/Amp/Cline followed. Embedding RAG is reserved for corpora where lexical recall fails. sqlite-vec remains pre-1.0 alpha.
- **Vercel AI SDK is the TS multi-provider standard** (`ai@7`). Its `LanguageModel` interface is itself the provider abstraction; `@ai-sdk/react` `useChat` is framework-agnostic (works in a Vite SPA against a Hono route — official cookbook).

## Decision

1. **Provider seam = AI SDK `LanguageModel`, nothing custom.** `apps/chat-server` adopts `ai@7`. A small `resolveModel(config)` reads `{baseURL, apiKey, model}` from env/prefs and returns a `LanguageModel` — first via `@ai-sdk/openai-compatible` pointed at the user's 9router; later providers (direct Anthropic/OpenAI) are config rows, zero code. No coding-plan endpoints are baked in.
2. **Agentic retrieval, no embeddings.** An FTS5 external-content table indexes a pre-folded plain-text shadow of `messages.body` (HTML-stripped, folded with the repo's Vietnamese fold: đ→d + strip marks + lowercase; `remove_diacritics=2` as belt-and-suspenders). The model plans queries itself through a small tool set — `search_messages`, `get_context`, `list_conversations`, `resolve_person` — in a step-capped agent loop. Embeddings (sqlite-vec) are deferred until lexical recall demonstrably misses.
3. **Citations are validated, not trusted.** Tool results stamp every row with `(convId, msgId)`. The model must cite via inline markers; the server validates every emitted marker against the set of ids actually surfaced by tool calls in that session and drops the rest. Valid citations render as chips deep-linking `/chat/c/{convId}?msg={id}` with scroll-to-message (the cited window is served from `chat.db`, never a provider cursor walk).
4. **Sessions persist as UIMessage rows in `chat.db`.** New `ai_sessions` + `ai_messages` tables (one row per UIMessage, `parts` as JSON, `sdk_major` stamped). Streams call `consumeStream()` so generation completes and persists even if the tab disconnects; no resumable-stream/Redis. Long sessions compact by summarization (what's *sent* shrinks; what's *stored* never does). Referenced chats/messages persist as `context_refs` descriptors (pinned cheaply every turn) with content injected once at attach and re-fetchable via tools.
5. **Transport = POST + UI message stream from Hono; UI = third column.** A new `/api/chat/assistant/*` Hono sub-app streams `toUIMessageStreamResponse()`; the existing `web/server.mjs` proxy forwards it untouched, and the WS hub stays Teams-deltas-only. The FE uses `@ai-sdk/react` `useChat` + selectively adopted AI Elements (shadcn-registry source copies) in a third column docked beside list+thread (full-screen stacked view on phone), so citations open in the main pane beside the assistant.

## Consequences

Easier: swapping LLM providers (config row); testing (pure fold/FTS/citation logic + a mock `LanguageModel`); privacy control (the corpus never leaves `chat.db` except the excerpts the tool loop surfaces to the configured provider); reusing the existing store/route/proxy seams (no `web/server.mjs` change).

Harder / accepted costs: answer quality is bounded by lexical recall (paraphrase-heavy queries may need the embeddings follow-up); the model sees message content — routing through 9router's fallback tiers can leak work messages to free-tier providers, so the assistant's model pin in 9router config is a user responsibility; UIMessage JSON is not stable across AI SDK majors (mitigated by `sdk_major` + tolerant validation, expect a small migration per major); FTS triggers must stay in lockstep with `upsertMessages` (all writes already funnel through it).

## Alternatives

- **z.ai Coding Plan key from the BFF** — rejected: documented ToS violation with an enforcement ladder that would also kill the user's coding-tool access. Router/metered endpoints only.
- **Embedding RAG (sqlite-vec)** — rejected for v1: alpha-stage extension, unnecessary at single-user scale, and the industry moved to agentic lexical search for exactly this data shape. Revisit as a hybrid layer behind the same `search_messages` tool.
- **Custom LLM provider interface** — rejected: the AI SDK `LanguageModel` already is that interface; wrapping it again is speculative abstraction.
- **assistant-ui** — rejected (again, with a corrected reason): the t129 multi-sender objection doesn't apply to a single-assistant pane, but it is a runtime framework with its own context/persistence model competing with the app's existing architecture, versus ~10 owned AI Elements files.
- **Streaming over the existing `/api/chat/ws` hub** — rejected: a custom `useChat` ChatTransport with zero official examples, when POST+SSE-style streaming is the documented path and already survives the deployed proxy stack.
- **ai@6** — rejected: greenfield on the previous major means paying a migration on persisted message rows later.
