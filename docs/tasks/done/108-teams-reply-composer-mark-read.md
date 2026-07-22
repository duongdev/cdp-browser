# 108 — teams reply: text composer + send + write-through mark-read

- **Status:** done
- **Mode:** HITL
- **Depends on:** t105 (creds + in-page seam), t106 (shell), t107 (thread pane + teams-render)
- **Blocks:** t109 (sweep — needs the `clientmessageid` echo-dedup this task introduces), t110 (rich compose)

## Goal

Reply to a Teams conversation from the chat app: a text composer at the bottom of the
thread pane sends via `POST /api/teams/reply` (in-page, CA-proof), optimistically appends
the sent message, and fails honestly (draft retained, no outbox). Sending also
**write-through marks the conversation read** on Teams (`consumptionHorizon`) per the Q9
hybrid decision (local read on open; write-through on reply / explicit mark-read) — so
Teams mobile/desktop/badge clear too. Send is **proven live** (self-chat `48:notes` → 201);
`consumptionHorizon` is the one unverified call — orchestrator confirms it live.

## Scope

- **`core/teams-reply.ts`** (pure, TDD; mirror `src/lib/slack-reply.ts`): `reduceSend(state,
  event)` composer state machine — `idle → sending → idle(sent, draft cleared) |
  failed(draft retained + typed code)`; `send` no-ops on empty/while-sending.
  `selectReplyTarget(conv)` — Teams chats are flat (no `thread_ts`), so the target is just
  the `convId`; keep the seam for parity/future channels. **Lives in `chat/src/lib/` or
  `core/`** — put it where the chat app imports it (chat/src/lib/teams-reply.ts, TDD).
- **`POST /api/teams/reply`** in `web/server.mjs` `{ convId, text }` → `getTeamsCreds` →
  in-page (`runInTeamsPage`) `POST {chatServiceBase}/v1/users/ME/conversations/{convId}/messages`
  body `{ content:text, messagetype:"Text", contenttype:"text", clientmessageid:<random>,
  imdisplayname:<displayName>, properties:{} }` → 201 `{ OriginalArrivalTime }` (= the msg
  id) → return `{ ok:true, ts, clientmessageid }`. 401 → `markTeamsCredsStale` + one retry →
  typed `invalid_auth`. **Return the `clientmessageid`** so t109's sweep can dedup the echo.
- **Write-through mark-read** — `POST /api/teams/mark-read` `{ convId, msgId, ts }` (or fold
  into the reply handler): in-page `PUT {chatServiceBase}/v1/users/ME/conversations/{convId}/properties?name=consumptionhorizon`
  with `{ consumptionhorizon: "{msgId};{ts};{clientmessageid|0}" }` (VERIFY the exact
  header/body/verb live — this is the unproven call; degrade gracefully on failure, never
  block the send). Called after a successful send; also exposed for an explicit
  mark-read. Reading a thread marks read **locally only** (no horizon write on open).
- **Composer UI** — an auto-grow `<textarea>` at the bottom of `thread-view.tsx` (build on
  shadcn, NO lib per the chat-ui research): Enter = send, Shift+Enter = newline, disabled
  while sending, send button. Optimistic: append the sent message (self, `ts` from the
  response) immediately; on failure keep the typed draft + show an inline error (reuse the
  `reduceSend` machine). `chat/src/lib/teams-client.ts`: `sendReply(convId, text)` +
  `markRead(convId, msgId, ts)`.
- **`core/teams-store.js`**: on send, `upsertMessages` the echo (so it persists); write
  `read_state` (`read_horizon_ts` on mark-read, `local_read_ts` on open). TDD the store bits.

## Acceptance criteria

- [ ] `reduceSend` state machine: empty/sending no-op, sent clears draft, failure retains
      draft + code. TDD.
- [ ] `POST /api/teams/reply` sends in-page (CA-proof) → 201 → returns `{ ok, ts,
      clientmessageid }`; 401 → one re-authz retry → `invalid_auth`.
- [ ] Sending write-through marks the conversation read (`consumptionHorizon`); failure to
      mark-read does NOT fail the send (best-effort).
- [ ] Composer: Enter sends, Shift+Enter newlines, disabled while sending; optimistic append;
      honest failure keeps the draft.
- [ ] Reading a thread marks read locally only (no horizon write on open).

## Test plan

- **Layer 1 (TDD):** `teams-reply.reduceSend` + `selectReplyTarget`; `teams-store` read_state
  + echo upsert.
- **Layer 2 (smoke, live keeper):** send to self-chat (`48:notes`) → 201, appears; verify
  `consumptionHorizon` clears the conversation's unread; delete the test message after.
- **Layer 3 (visual, REQUIRED):** composer states — empty, typing, sending, sent (optimistic
  append), failed (draft retained + error) — screenshotted against a stubbed reply.

## Design notes

- `reduceSend` mirrors `slack-reply.ts` exactly (same composer contract) so the thread view
  is source-agnostic. `selectReplyTarget` is the single owner of where a reply lands (flat
  convId for chats; the seam is where channel-thread logic would go later).
- The `clientmessageid` is load-bearing for t109: the sweep will re-see this sent message, so
  it must dedup by `clientmessageid` — return + persist it now.
- Covered by ADR-0018; no new ADR.

## Out of scope

- Edit/delete own messages, reactions (t110). Attachments (t111). Rich-HTML compose/render
  (the DOMPurify task). The poll sweep + echo-dedup wiring (t109 — t108 only ensures the
  `clientmessageid` exists). Typing indicators / presence.

## Definition of Done

- [ ] Layer 1 green; Layer 2 smoke (live self-chat send + mark-read + cleanup); Layer 3 shots.
- [ ] `pnpm check` (touched), `typecheck`, `test`, `node --check web/server.mjs`, `chat:build`, `/` build unchanged.
- [ ] CLAUDE.md updated (reply + mark-read + composer). No AI attribution / console debris.
- [ ] Task → done, moved to `done/`, `t108` in commit.

## Notes

- Send body + 201 `{OriginalArrivalTime=msgId}` PROVEN live (self-chat). `consumptionHorizon`
  verb/path/body UNPROVEN — verify live, degrade gracefully.
- Worktree: docs on main, code on feature branch (2-commit ship); never `git add -A`;
  `--no-verify` (rtk breaks pre-commit).
