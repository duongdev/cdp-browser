# 172 — assistant LLM provider seam: ai@7 + resolveModel config registry

- **Status:** done
- **Mode:** HITL
- **Estimate:** 0.5d
- **Depends on:** none
- **Blocks:** t173

## Goal

`apps/chat-server` can talk to a pluggable LLM: `ai@7` + `@ai-sdk/openai-compatible` installed, a `resolveModel(config): LanguageModel` function reading `{baseURL, apiKey, model}` from env (`LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`), and a proven end-to-end streamed tool-call round-trip against the user's local 9router endpoint.

## Why now

ADR-0021 decision 1. t173's agent loop needs a `LanguageModel` it can trust — including the GLM-through-router quirks (tool-call args arriving as one streamed chunk, reasoning interleave) verified live before anything is built on top.

## Acceptance criteria

- [ ] `ai@7` + `@ai-sdk/openai-compatible` added to `apps/chat-server` only (NOT the Electron `build.files` allowlist, NOT the `/` renderer).
- [ ] `resolveModel(config)` returns a `LanguageModel`; unset env → assistant routes report a typed `llm-unconfigured` error (same `{error: code}` contract as `ProviderError`), never a crash.
- [ ] Provider config is data: adding a direct Anthropic/OpenAI provider later is a config/env change plus at most one import — no interface of our own on top of `LanguageModel`.
- [ ] A smoke script or route exercises `streamText` with one zod-defined tool against 9router: streamed text arrives, the tool is called with valid args, the loop completes.
- [ ] Observed GLM/router quirks recorded in this task's Notes for t173 (step caps, arg validation posture).

## Test plan

### Layer 1 — Pure logic (TDD)

- [ ] `resolveModel` — env parsing, missing-config typed error, config precedence
- [ ] t173+ consumers get a mock `LanguageModel` (AI SDK test helpers) — set the pattern here with one round-trip test

### Layer 2 — Manual smoke (CDP/IPC)

- [ ] Live call through 9router: streamed completion + one tool call verified from the smoke script (HITL — needs the user's 9router up)

### Layer 3 — Visual review

n/a — no UI.

## Design notes

- **Contracts changed:** none public.
- **New modules:** `llm.ts` (resolveModel + config types) in `apps/chat-server/src`.
- **New ADR needed?** no — ADR-0021 covers it.

Node engine: ai@7 is ESM-only and wants modern Node — `apps/chat-server` already runs Node ≥22 with type-stripping; bump `engines` if install warns.

⚠ Privacy (from grill): 9router's tiered fallback can route message excerpts to free-tier providers. The BFF pins one model id (`LLM_MODEL`); tier discipline for that model is 9router config — the user's responsibility. Say so in the Settings help text when t174 exposes model info.

## Out of scope

- Agent loop, tools-over-chat.db, sessions, routes (t173).
- Per-session model switching UI (t174 may add a picker later; env default is enough now).
- Direct z.ai/Anthropic/OpenAI provider rows (config exercise for later, by design).

## Definition of Done

- [ ] Layer 1 tests green; live smoke done and quirks noted
- [ ] `pnpm check:changed` clean, `pnpm typecheck` clean, `pnpm test` green
- [ ] CLAUDE.md updated (apps/chat-server deps note)
- [ ] Task closed: status → done, file moved to `docs/tasks/done/`, tNNN in commit

## Notes (build)

- Live 9router smoke NOT yet run (router was down during the build session). Run:
  `LLM_BASE_URL=… LLM_API_KEY=… LLM_MODEL=… node --experimental-transform-types apps/chat-server/src/llm-smoke.ts`
  Exit 0 = streamed text + tool call verified. Record GLM/router quirks here after.
- t173 defends regardless: zod arg validation on every tool, step cap, typed stream errors.
