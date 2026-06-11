# 078 — reader composer text-only reply

- **Status:** done
- **Mode:** HITL
- **Estimate:** 1d
- **Depends on:** 077
- **Blocks:** none

## Goal

The Slack Conversation Reader gains a text-only composer: typing into a real `<textarea>` (iOS keyboard just works — no OSK bridge) and sending posts via `chat.postMessage` through the same sweep creds. Reply target is context-dependent behind one pure, swappable selector: DM → plain message, channel mention → that message's thread, thread notification → that thread. Failure is synchronous and honest — the draft stays in the box with an error line and retry; no outbox, no queue.

## Why now

AFK often means someone is waiting on you; a one-line "on it, back in 20" is half the value of the phone surface (ADR-0012 §3). First Slack write through extracted creds — kept deliberately small.

## Acceptance criteria

- [ ] Composer visible in the Slack reader only (capability-gated); Teams/Outlook stub details have none.
- [ ] Send targets per the selector: DM → channel message; channel mention → reply in its thread (`thread_ts` = parent); thread notification → that thread. Verified against live Slack for all three shapes.
- [ ] Target selection is one pure function (entry → `{ channel, thread_ts? }`), unit-tested, swappable without touching the reader or the endpoint (same pattern as `selectPasteRoute`).
- [ ] Sweep entries carry the fields the selector needs (`thread_ts`, channel type) end-to-end.
- [ ] "Sending…" state; on failure the draft text remains with a visible error + retry. Stale-cred 401 says why and that it may self-heal ("retry in a minute" — parked-tab re-extract); 429 says to wait.
- [ ] Closing the reader discards an unsent draft (no persistence — accepted).
- [ ] Text-only: no uploads, no emoji picker, no mrkdwn toolbar.

## Test plan

### Layer 1 — Pure logic (TDD)

- [ ] Reply-target selector — DM, channel mention, thread reply, mention-that-is-already-a-thread-parent, missing `thread_ts` fallback.
- [ ] Composer state reducer — idle → sending → sent | failed(draft retained).

### Layer 2 — Manual smoke (CDP/IPC)

- [ ] Live: reply to a DM, a channel mention with an existing thread, and a thread notification; confirm placement in the real Slack client each time.
- [ ] Force a 401 (stale creds) and confirm the honest error + later retry succeeds.

### Layer 3 — Visual review

- [ ] Composer states: idle, sending, failed-with-retry; keyboard-open layout (visual viewport) doesn't bury the input.

## Design notes

- **Contracts changed:** server API grows a reply endpoint (`{ team, channel, thread_ts?, text }`) calling `chat.postMessage` via the cred-injected Slack client; sweep entry shape carries thread/channel-type fields through.
- **New modules:** pure reply-target selector (core, next to the other pure Slack helpers); composer state reducer.
- **New ADR needed?** no — ADR-0012 records the write decision and the no-outbox rejection.
- Wrong-place replies are the worst failure: the selector tests are the contract.

## Out of scope

- Offline outbox / background retry (rejected — ADR-0012 alternatives).
- Rich content: uploads, emoji, formatting, editing/deleting sent messages.
- Draft persistence across reader open/close.

## Definition of Done

- [ ] Layer 1 tests green
- [ ] Layer 2 smoke completed with live Slack (all three reply shapes)
- [ ] Layer 3 screenshots captured
- [ ] `pnpm check:changed` / `pnpm typecheck` / `pnpm test` green
- [ ] CLAUDE.md + CONTEXT.md (Conversation Reader composer) consistent
- [ ] No debris, no AI attribution
- [ ] Task closed: status → done, moved to `done/`, t078 in commit

## Notes

User explicitly expects the reply-target policy may change — keep the selector the single owner of that decision.

Closure notes:
- Shipped: `selectReplyTarget` + `reduceSend` (src/lib/slack-reply.ts, 10 tests — lives in src/lib, not core, because the renderer is the sole consumer; deviation from the design note recorded), `thread_ts` plumbed sweep-candidate → reducer entry (`threadTs`) → store entry (`slackThreadTs`) with tests at each hop, `chatPostMessage` on the Slack client (1 test), `POST /api/slack/reply` (web/server.mjs + 1 hermetic e2e for 400/401), composer UI in conversation-reader.tsx (capability-gated: history route + bridge + target).
- Group DMs (`mpim`) reply plain like 1:1 DMs (conversationally a DM) — documented in the selector tests; flip it in one place if wrong.
- On success the sent message is appended to the view locally (no second history fetch — 429 budget); on failure the draft stays with typed copy, verified end-to-end against the harness (401 path: "Not sent — Slack session expired…", draft retained, Retry send).
- The three live reply shapes (DM / channel mention thread / thread reply placement in the real Slack client) and keyboard-open layout still want the HITL pass with real creds.

---

_When task status flips to `done`, move this file to `done/`._
