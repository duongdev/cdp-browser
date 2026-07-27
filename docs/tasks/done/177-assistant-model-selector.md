# 177 — assistant model selector: per-session picker in the composer

- **Status:** done
- **Mode:** HITL
- **Estimate:** 0.5d
- **Depends on:** t174
- **Blocks:** none

## Goal

A model selector in the assistant panel, VSCode-Copilot-chat style: a compact control in the prompt-input footer showing the active model name + chevron, opening a dropdown of available models. Selection is **per session** (persisted on `ai_sessions.model` — the column t173 already ships), applies from the next turn, and new sessions default to the env model. Styled entirely with the existing CDP Chats design system (shadcn radix-nova, HugeIcons, same tokens as the rest of `/chat`).

## Why now

Follow-up to t174 (which ships env-default only). Live testing showed a real quality/latency spread — `glm/glm-4.7` at 3.9s vs `glm/glm-5.1`→5.2 at 10.5s — worth a one-tap switch per conversation, same as Copilot's picker.

## Acceptance criteria

- [ ] BFF: `GET /api/chat/assistant/models` returns a curated list `{id, label, default}` from env `LLM_MODELS` (comma-separated `id[:label]` pairs; falls back to the single `LLM_MODEL`) — never the raw router `/v1/models` dump (70 entries, mostly noise).
- [ ] Chat route resolves the session's `model` through `resolveModel` per request; unknown/stale stored id falls back to the env default with a visible (non-blocking) notice.
- [ ] Selector sits in the prompt-input footer (Copilot placement): current model label + chevron; dropdown lists curated models with the active one checked; keyboard accessible.
- [ ] Picking a model updates `ai_sessions.model` (session CRUD PATCH), takes effect next turn, survives reload/session switch.
- [ ] New session inherits the env default; session picker rows may show a small model tag when the session deviates from the default.
- [ ] Built on owned shadcn primitives (DropdownMenu, or the AI Elements PromptInput model-select slot if it was adopted in t174) — no new dependency.
- [ ] Four-state coverage on the models fetch: loading (selector disabled, default label), empty/single-model (selector hidden), error (hidden + env default used), populated.

## Test plan

### Layer 1 — Pure logic (TDD)

- [ ] `LLM_MODELS` env parsing — `id`, `id:label`, whitespace, empty → fallback to `LLM_MODEL`, default flag
- [ ] session-model resolution — stored id valid / stale / absent → chosen model + fallback flag

### Layer 2 — Manual smoke (CDP/IPC)

- [ ] Live: switch a session between two GLM models via 9router, verify next answer's served model changes (response `model` field)

### Layer 3 — Visual review

- [ ] Screenshots via /cdp + chrome-devtools MCP: selector closed/open, deviating-session tag, single-model hidden state; wide + phone shells

## Design notes

- **Contracts changed:** assistant section of `contract.ts` gains the models list shape + session PATCH accepting `model`.
- **New modules:** none of substance — env parser beside `resolveModel` (t172), one small FE component in `chat/src/components/ai/`.
- **New ADR needed?** no — ADR-0021 already makes the model a config value; this exposes it.

Keep the switch honest: no mid-stream model change (an in-flight turn finishes on the model it started with).

## Out of scope

- Per-message model override or model-per-quick-action routing.
- Cost/latency badges in the dropdown (revisit if the curated list grows).
- Any provider-management UI (adding providers stays env config).

## Definition of Done

- [ ] Layers 1–3 done as above
- [ ] `pnpm check:changed` clean, `pnpm typecheck` clean, `pnpm test` green, `pnpm chat:build` succeeds
- [ ] CLAUDE.md updated (chat app section)
- [ ] Task closed: status → done, file moved to `docs/tasks/done/`, tNNN in commit

## Notes (build)

- Verified in the mock harness (LLM_MODELS="fake:GLM 4.7 (fast),fake2:GLM 5.1 (smart)"): selector
  renders in the prompt-input footer, dropdown lists curated models with default tag + active
  check, a pick persists to ai_sessions.model and the label updates; deviating sessions show a
  model tag in the quick-switch dropdown. Live served-model verification vs 9router = HITL.
- Stale stored id → server falls back to env default (validated against the curated list in the
  chat route); the selector shows a non-blocking "using the default" note.
