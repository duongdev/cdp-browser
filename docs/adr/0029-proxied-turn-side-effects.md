# ADR-0029: A proxied turn keeps chat-server's side effects, and outlives its socket

- **Status:** Accepted
- **Date:** 2026-08-06
- **Issue:** t179
- **Amends:** ADR-0028 decision 6 (client abort forwarded on disconnect). Decisions 1–5 stand unchanged.
- **Relates to:** ADR-0021 (agentic retrieval, decision 4 — generation completes without the client)

## Context

ADR-0028 diverted `POST /api/chat/assistant/:sessionId` to the Hermes agent. What it did not
account for is that chat-server's turn handler owns four side effects **inline**, in the same
function body that runs the model:

1. persisting the user message and the assistant reply
2. generating the session title after the first exchange
3. compaction past the context budget
4. token accounting

Diverting the route skipped the entire function, so all four stopped happening — silently, with
a green test suite, because every test exercised one path or the other and none compared them.

Measured on preview against prod as a control (same code, same DB, only the Hermes env differs):

| | prod (BFF) | preview (Hermes) |
|---|---|---|
| messages stored after 2 turns | 1 | **0** |
| session title | `'New session'` | `null` |

The panel loads its thread from chat-server (`assistant-panel.tsx`, `messages: initial`), so
zero rows means the conversation existed only in the tab's memory: a reload or a session switch
showed an empty thread, while Hermes still held the history and answered as if nothing was lost.
The two states disagreed and neither said so.

The model picker failed the same way but louder. `PATCH /sessions/:id {model}` returned 200 and
the selector rendered the chosen model, while the proxy sent Hermes a payload containing only
`message` and `system_message` — every turn ran on `hermes-default`. A label that is wrong is
worse than a label that is missing, because it is believed.

## Decision

### 1. The proxy records the turn through chat-server, not around it

A new route, `POST /api/chat/assistant/sessions/:id/messages`, persists one message. With
`maintain: true` it also runs the same `afterTurnMaintenance` the BFF path runs.

The alternative — reimplementing title generation and compaction in the proxy — was rejected.
Two implementations of the same rule drift, and the drift is invisible until someone compares
the two paths, which is exactly the failure this ADR exists to fix.

The route validates id, role, parts shape and body size, and returns 400/413 rather than storing
a malformed row. A bad row here is permanent: it lands in history and breaks every future reload
of that thread.

### 2. Model selection is a session LOCK, not a per-request field

Measured against the live gateway:

```
POST /api/sessions/{id}/model {glm/glm-5.1}   -> 200, lock=confirmed
next turn                                      -> runs glm/glm-5.1
turn with body {model: glm/glm-4.7}            -> still runs glm/glm-5.1
```

Hermes precedence is **lock > session override > session row > per-request**. Once a session
carries any lock, a per-request `model` is silently ignored — so the obvious fix (forward
`model` in the turn payload) would have worked on a fresh session and quietly stopped working
after the first switch. Same lying label, one layer deeper, and harder to find.

The lock is applied only when the wanted model differs from what the proxy last locked, so the
steady state costs no extra round-trip. Conversation history survives a switch (verified: the
session still recalled a word established before the lock).

The wanted model is the session's stored pick, falling back to the entry marked `default: true`
in `GET /api/chat/assistant/models` — which is `LLM_MODEL` on the deployment. One place to
change the model.

### 3. A confirmed model switch is a visible row, not just a log line

A switch writes a `system` message rendered as a centred divider (`Model changed to X`). It is
identified by `metadata.kind === "model-change"`, never by matching its text — otherwise a user
could forge one by typing the same sentence.

It is written **after** the gateway confirms the lock. A refused lock writes nothing, so the
thread can never claim a switch that did not take.

Marker rows are stored and rendered but filtered out of what is sent to the model: a model
reading `Model changed to X` would treat it as an instruction it had been given.

### 4. A dropped socket no longer cancels the turn — this amends ADR-0028 decision 6

ADR-0028 forwarded an abort whenever the response closed, because at the time a closed socket
could only mean "the user pressed Stop".

That conflates two very different events. A user who switches tabs, navigates away, or loses
their connection has not cancelled anything — and killing the run leaves them with a question
and no answer and no explanation. Dustin's call: the turn survives the socket, the proxy keeps
draining the stream to completion, and the answer is recorded when it lands.

So Stop had to become explicit: `POST /api/chat/assistant/:sessionId/stop`, sent by the panel
before it closes its own stream. The proxy maps session → live translator → `run_id`.

This is ADR-0021 decision 4 (`consumeStream`: generation completes even if the tab disconnects)
restored on the Hermes path, where t178 had inverted it.

### 5. The pending state is written before the answer exists

The user message is persisted **before** the turn starts, and a stopped turn is recorded with
`metadata.interrupted` rather than dropped.

The rule: no silent state loss. An unrecorded partial answer is indistinguishable from a turn
that never ran, and a question with no row at all is indistinguishable from a question never
asked. Both leave the user unable to tell what happened.

Recording is best-effort in one direction only — a failed write costs the record, never the
answer the user already waited for and already paid for.

## Consequences

**Gained.** The Hermes path and the BFF path now produce the same durable record, from the same
code. Reloading a session shows what happened, including turns that are still running and turns
that were stopped. The model picker tells the truth.

**Cost.** Two extra chat-server round-trips per turn (user row before, assistant row after) plus
one model-catalogue read per session per 5 minutes. Both are local to the deployment and off the
model's critical path.

**Not solved.** A second tab cannot attach to a running turn — recording preserves the outcome,
not the keystroke-level stream. Resumable streaming was rejected by ADR-0021 decision 4 and
nothing here changes that. Token accounting (`addTokens`) is still not fed on the Hermes path.

**Restart safety.** `hermesModelBySession` is an in-process cache, so after a `web/server.mjs`
restart the proxy has no memory of any session. Treating that as "nothing was locked" would
write a `Model changed to X` row into every thread on its next turn — a marker announcing a
switch that did not happen, which is the same class of lie this ADR removes.

The gateway persists the lock, so the proxy asks it (`GET /api/sessions/{id}`) whenever its own
cache is empty, and uses that as the previous value. Verified: after a lock the session reports
`model: 'glm/glm-5.1'`; an unknown session 404s and is treated as "no previous", not an error.

For the same reason `changed` and `announce` are separate. An unlocked session reports the
gateway's own virtual model name (`hermes-agent`), which the user never picked and would not
recognise, so only a move between two ids the panel actually offers is written to the thread.
