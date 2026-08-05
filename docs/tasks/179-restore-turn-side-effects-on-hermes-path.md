# 179 — restore the turn's side effects on the Hermes path

- **Status:** in-progress
- **Mode:** HITL
- **Estimate:** 0.5d
- **Depends on:** t178
- **Blocks:** PSN-138 (delete `assistant/`)

## Goal

A turn proxied to the Hermes agent produces the same durable record as a turn that ran on
chat-server: the exchange is persisted, the session gets named, the model the user picked is
the model that answers, and a turn the user walks away from is still there when they come back.

## Why now

t178 diverted the turn route to Hermes but chat-server's turn handler owns four side effects
*inline*, so diverting the route silently dropped all of them.

Measured on preview, same code and same DB, prod (BFF) as control:

| | prod (BFF) | preview (Hermes) |
|---|---|---|
| messages stored after 2 turns | 1 | **0** |
| session title | `'New session'` | `null` |

The panel loads its thread from chat-server, so 0 rows means a reload showed an empty
conversation while Hermes still held the history. Dustin reported the missing title and the
dead model picker; the lost history was found while confirming those.

The model picker was the worst of the three: `PATCH /sessions/:id {model}` returned 200 and the
selector rendered the chosen model, while the turn ran on `hermes-default`. A label that is
wrong is worse than one that is missing, because it is believed.

## Approach

Reuse chat-server's own code rather than reimplementing it in the proxy. A new recording route
(`POST /sessions/:id/messages`) persists one message and, with `maintain: true`, runs the same
`afterTurnMaintenance` the BFF path runs — so title generation and compaction stay in one place.

**Model: lock, not per-request.** Measured against the live gateway:

```
POST /api/sessions/{id}/model {glm/glm-5.1}   -> 200, lock=confirmed
next turn                                      -> runs glm/glm-5.1
turn with body {model: glm/glm-4.7}            -> still runs glm/glm-5.1
```

Hermes precedence is lock > session override > session row > per-request, so once a session
carries a lock a per-request `model` field is ignored. Forwarding per-request would have worked
on a fresh session and quietly stopped working after the first switch — the same lying-label
bug, one layer down. History survives the switch (verified: the session still recalled a word
from before the lock).

**Pending state (Dustin's option B).** The user message is written *before* the turn starts and
a dropped socket no longer cancels the run. Coming back to a session mid-turn shows the question
and, once it lands, the answer. A partial answer from a stopped turn is recorded and flagged
`interrupted` — an unrecorded partial is indistinguishable from a turn that never ran.

That makes socket-close useless as a cancel signal, so Stop became explicit:
`POST /api/chat/assistant/:sessionId/stop`.

**Model switches are visible.** A confirmed lock writes a `system` row rendered as a centred
divider (`Model changed to X`), keyed off `metadata.kind` so it cannot be forged by typing the
same sentence, and filtered out of what is sent to the model.

## Files

| File | Change |
|---|---|
| `apps/chat-server/src/assistant/routes.ts` | recording route; marker rows excluded from the model transcript |
| `core/hermes-record.js` | new — message rows + the write-back call |
| `core/hermes-model.js` | new — catalogue read, session pick, lock application |
| `core/hermes-agent-client.js` | `lockModel`, `sessionModel`; `stopRun` no longer fires on disconnect |
| `core/hermes-sse-translator.js` | accumulate the answer for recording |
| `core/hermes-route.js` | stop-route predicate |
| `web/server.mjs` | record the turn, apply the model, explicit stop route |
| `chat/src/components/ai/assistant-panel.tsx` | Stop signals out-of-band; marker row rendering |

## Acceptance criteria

- [x] A turn through the proxy leaves user + assistant rows in chat-server
- [x] A new session gets a generated title after its first exchange
- [x] The panel's model pick is the model that answers
- [x] A confirmed model switch appears as a marker row in the thread
- [x] Marker rows are never sent to the model
- [x] Leaving mid-turn does not cancel the run; the answer is recorded
- [x] Explicit Stop cancels the run
- [x] A stopped turn is recorded as interrupted, not dropped
- [x] Recording failures degrade the record, never the answer
- [x] Reply suggestions use the deployment's default model (adapter, out of repo)
- [ ] Verified on deployed preview

## Verification

Unit: 183 files / 2448 tests pass. `tsc --noEmit` clean, `node --check web/server.mjs` OK.

Mutation: **23/23 killed** (`/tmp/mutate_t179.py`), judged by vitest exit code.

Two mutants survived earlier rounds and are worth recording, because both were tests that could
not fail:

1. Reverting the marker-row filter left the suite green — a `system` row reaching
   `convertToModelMessages` throws `AI_InvalidPromptError` before the model is called, so "the
   transcript does not contain the marker" was trivially true of an empty transcript. Fixed by
   also asserting the model was reached.
2. Removing the `res.ok` check in `sessionModel` survived, because the fake returned clean JSON
   on a 404 — a shape no real server produces. Fixed by making the error fixture behave like an
   error, and by adding the case that actually distinguishes the two: a 5xx whose body still
   parses (proxy error page, gateway mid-restart), which without the status check would be read
   as authoritative and skip a lock the session needs.

Same class of blind spot as t178's stub BFF: a double that agrees with its author validates the
wiring and nothing else.

A third issue was found by probing rather than by tests: `hermesModelBySession` is in-process,
so after a proxy restart every session looked unlocked and would have been announced as a model
switch on its next turn. The gateway persists the lock, so it is now asked for the previous
value when the cache is cold.

Adapter (outside this repo, `~/.hermes/plugins/cdp-chat/`): 12 checks, 5/5 mutants killed.

## Out of scope

- Resumable streaming (a second tab attaching to a running turn). ADR-0021 decision 4 chose
  server-side completion over stream resumption; recording preserves the outcome, not the
  keystroke-level stream.
- Token accounting on the Hermes path — `addTokens` is not fed by the proxy yet.
