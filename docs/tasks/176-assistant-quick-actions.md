# 176 — assistant quick actions: summarize, catch-up, draft reply, action items

- **Status:** ready
- **Mode:** HITL
- **Estimate:** 1d
- **Depends on:** t174
- **Blocks:** none

## Goal

Four one-tap assistant affordances on the t173/t174 foundation: **Summarize conversation** (message-actions/thread menu → session seeded with the conv ref + canned prompt), **Catch-up digest** ("what did I miss?" — reads `read_state` + recent messages across conversations, answers with per-conversation citations), **Draft reply** (generates a reply in the thread's language/register, inserted into the composer — never auto-sent), and **Action items** (scans `mentions_me` + recent threads for asks/deadlines into a cited checklist).

## Why now

The extras grilled into v1 — each is a prompt seed + at most one new tool over machinery that exists after t174; batching them keeps prompts/UX consistent.

## Acceptance criteria

- [ ] Summarize: thread header + message-actions entry; opens panel, attaches conv ref, runs a canned summarize prompt; output cites key messages.
- [ ] Catch-up: panel suggestion + ⌘K; new tool `get_unread_overview` (per-conversation unread counts + recent unread excerpts from `read_state`/`messages`) feeds a digest grouped by conversation with deep links; respects muted conversations by default.
- [ ] Draft reply: message-actions entry; assistant drafts in the thread's dominant language (VN/EN mirroring); "Insert into composer" puts the draft into the Tiptap composer for editing — no auto-send path exists; draft tone guidance read from a user-editable prefs blob (DB `prefs`, NOT committed to the repo — OSS boundary).
- [ ] Action items: panel suggestion + ⌘K; cited checklist of asks/deadlines targeting the user; states "none found" honestly.
- [ ] All four ride the normal session model (visible in history, compactable) — no hidden side-channel calls.
- [ ] Each action has a typed failure state (llm-unconfigured/429/timeout) consistent with t174.

## Test plan

### Layer 1 — Pure logic (TDD)

- [ ] `get_unread_overview` shaping against `:memory:` DB — unread math per conversation, mute filtering, excerpt caps
- [ ] prompt-seed builders — ref attach + template composition pure functions
- [ ] composer-insert seam — pure mapping from draft text to editor insert payload

### Layer 2 — Manual smoke (CDP/IPC)

- [ ] Live: each action once against real data via 9router; verify citations resolve and draft lands in composer unsent

### Layer 3 — Visual review

- [ ] Menu/⌘K entries + suggestion chips in panel empty state; four states for each action's run

## Design notes

- **Contracts changed:** one new tool + prefs key (`assistant.voice` guidance blob) in `contract.ts`.
- **New modules:** prompt-seed lib (pure) in BFF; small FE glue for menu entries + composer insert.
- **New ADR needed?** no.

Catch-up token discipline: excerpts, not full bodies, capped per conversation — the tool result must stay compact (Anthropic tool-writing guidance from research).

## Out of scope

- Scheduled/push digests (deferred — future task).
- Translation action (deferred).
- Auto-send anything, ever.

## Definition of Done

- [ ] Layers 1–3 done as above
- [ ] `pnpm check:changed` clean, `pnpm typecheck` clean, `pnpm test` green, `pnpm chat:build` succeeds
- [ ] CLAUDE.md updated (chat app section)
- [ ] Task closed: status → done, file moved to `docs/tasks/done/`, tNNN in commit
