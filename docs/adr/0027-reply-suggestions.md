# ADR-0027: Reply suggestions — a provider-agnostic surface, backed by the Hermes agent

- **Status:** Accepted
- **Date:** 2026-08-03
- **Issue:** PSN-140
- **Relates to:** ADR-0021 (agentic retrieval), ADR-0026 (MCP write tools), ADR-0024/0025 (MCP server, tailnet)

## Context

The composer already accepts machine-written text. `t176` built that path end to end:
`assistant-panel` → `chat-app.insertDraftToComposer` → `thread-view.insertDraft` →
`composer.insertText`. Its comment states the rule this ADR inherits: *"Insert assistant-drafted
text into the composer for editing — never auto-sent (t176)."*

What is missing is upstream. Today a draft exists only if the user opens the assistant panel, types
a prompt, and clicks insert on the reply. There is no surface that says *"here are 2–3 things you
could send in this thread, pick one"*.

The Hermes cdp-chat plugin already writes those drafts — `_draft_reply()` produces one per incoming
message when handoff mode is on, and posts it to Discord. So the user reads a suggested reply on his
phone, then retypes it in the app he is actually looking at. The text exists; it is delivered to
the wrong surface.

### Why the agent, not `llm.ts`

A suggestion is only worth reading if it sounds like the user. That likeness does not come from the
model — it comes from context the model is given: the user's voice profile, prior replies to this
specific colleague, what he already promised in other threads, what is on his Linear board. That
context lives in Hermes (memory, session history, its other tools). `apps/chat-server/src/llm.ts`
has a model client and `chat.db`. Given the same prompt it would return competent, generic,
recognisably-AI text — the exact failure the user has already named as disqualifying.

This also settles a sequencing question: PSN-138 plans to delete `assistant/`. Building suggestions
on `llm.ts` would put new load-bearing code on a module scheduled for removal.

### Why the transport is already there

The Hermes plugin is **already a WebSocket client of the same hub the UI uses**
(`adapter.py:404` derives `/api/chat/ws`, `ws-hub.ts:150` `attachWsHub`). It consumes
`messages-upsert` today. The hub is a bidirectional fan-out that both the browser and the agent are
attached to. Nothing new needs to be built to carry an event from the agent to the UI or a request
from the UI to the agent — only new frame types on an existing socket.

The alternative considered was an HTTP callback from chat-server into the Hermes gateway. Rejected:
it needs a second URL, a second auth story, and a second failure mode, to move bytes across a
socket both parties already hold open.

## Decision

### 1. The stored artifact is provider-agnostic; the producer is named, not assumed

A new table `reply_suggestions` and the routes over it know nothing about Hermes:

```sql
CREATE TABLE IF NOT EXISTS reply_suggestions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  service     TEXT NOT NULL,
  conv_id     TEXT NOT NULL,
  for_msg_id  TEXT,              -- message that prompted this batch; NULL = manual generate
  producer    TEXT NOT NULL,     -- 'hermes' today; the column is why a second one costs nothing
  created_at  INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open',  -- open | chosen | dismissed | superseded
  texts       TEXT NOT NULL,     -- JSON string[] — the batch, ordered
  chosen_idx  INTEGER,           -- set when the user inserts one
  chosen_at   INTEGER,
  sent_msg_id TEXT,              -- set when a send lands in this conv after a choice
  sent_text   TEXT,              -- what was ACTUALLY sent (see decision 4)
  sent_at     INTEGER
)
```

`producer` is not speculative generality — it is the difference between "the suggestions feature"
and "the Hermes feature". A local model, a canned-response list, or a second agent all fit without
a migration. The abstraction stops there: no producer registry, no strategy interface, no plugin
loader. One column, and a `WHERE`.

**Batch, not row, is the unit.** The three texts of one generation are alternatives to each other —
choosing #2 is a statement about #1 and #3 too. Storing them as three rows loses that. A JSON array
in one row keeps the batch intact and makes `chosen_idx` meaningful.

### 2. Both triggers, one path

- **Automatic** when handoff mode is on and a message arrives that the classifier deems worth
  answering. The user is away; the point of handoff is that suggestions are waiting when he returns.
- **Manual** via a generate / regenerate button in the thread. The user is present and wants options
  for *this* thread now.

Both produce the same batch through the same code. Manual regeneration marks the previous open
batch `superseded` rather than deleting it — a regenerate is a signal ("the first three were not
good enough") and deleting the evidence destroys it.

Handoff mode is already a Hermes-side state (`~/.hermes/cdp-chat-state.json`). The trigger decision
stays there. chat-server does not learn what handoff means; it stores what it is given.

### 3. Two new WS frames, no new transport

Server → client (fan-out to the UI, emitted when a batch is written):

```ts
| { type: "reply-suggestions"; service: ChatService; convId: string
    batch: ReplySuggestionBatch | null }   // null = the batch for this conv was cleared
```

Client → server (the generate button; relayed to producers on the hub):

```ts
| { type: "suggest-request"; convId: string; regenerate?: boolean }
```

`ChatWsClientMessage` is currently a single-member union (`focus`); this makes it a real union.

The agent receives `suggest-request` on the socket it already holds, generates, and writes the batch
back through the REST route in decision 5 — which broadcasts `reply-suggestions` to every client,
including the tab that asked. Request and response are deliberately not correlated by an id: the
batch is conversation state, not a reply to one caller. A second tab focused on the same thread
should see it too.

### 4. Track what was suggested AND what was actually sent

The insert is not the end of the interaction. The user picks a suggestion, then edits it in the
composer, then sends. The edit is the highest-value signal in the whole feature — it is the
difference between what the agent thought he would say and what he actually said. Recording only
`chosen_idx` throws that away and leaves nothing to learn from.

So: on choose, store `chosen_idx` + `chosen_at`. On the next send into that conversation, store
`sent_msg_id` + `sent_text` + `sent_at` against the open chosen batch. The diff between
`texts[chosen_idx]` and `sent_text` is the training signal.

**Attribution is heuristic and must stay honest.** The link between a choice and a send is
"the next message this user sent to this conversation, within a window". A user who inserts a
suggestion, deletes it, types something unrelated and sends will produce a row claiming a
relationship that did not exist. That is acceptable for a metric and **not** acceptable as a
training label without review — recorded here so a later confidence model does not silently trust
it. Anything beyond a window (composer-level provenance tracking through an edit session) is
deferred until the data proves it is needed.

### 5. Writes go through REST, reads through REST + WS

`POST /api/chat/suggestions` (producer writes a batch), `POST /api/chat/suggestions/choose`,
`POST /api/chat/suggestions/dismiss`, `GET /api/chat/suggestions?convId=` (hydrate on thread open —
the WS only carries deltas, so a client that connects after a batch was written needs a read).

Not an MCP tool. ADR-0026's write tools operate on **Teams** — they send, edit, and delete real
messages. A suggestion is local state that never leaves the machine unless the user sends it. Same
reason `/prefs` is not an MCP tool. If the agent later needs to read its own past suggestions to
learn from them, that is a read tool and a separate decision.

### 6. Auto-send stays off, and this ADR does not build the mechanism

Explicit user instruction: no auto-send until there is a working confidence score, an improvement
loop, and his sign-off. This ADR builds the surface and the data that a confidence score would need
to exist. It adds **no** code path that sends without a human pressing send. `insertText` puts text
in the composer; the send button remains the only thing that reaches Teams.

This is worth stating in a decision rather than a note, because the tempting next commit — "if
confidence > X, just send it" — is a three-line change against this schema. The gate is the user's
green light, not the code's readiness.

## Consequences

**Good.** The suggestion arrives where the user is already looking. The existing `insertText` path
carries it, so the never-auto-sent guarantee is inherited rather than re-implemented. The agent
keeps its context advantage. The `producer` column means a non-Hermes source is a config change.
Every suggestion and every send is recorded, so "is this actually good?" becomes a query.

**Costs and risks.**

- **Suggestions can be stale.** A batch generated for message N is still displayed after messages
  N+1..N+3 arrive. Mitigation: batches carry `for_msg_id`; the UI marks a batch stale when newer
  messages exist. Not auto-regenerated — that would burn tokens on threads the user never opens.
- **The agent must be running.** With the Hermes gateway down, the generate button does nothing.
  The UI must show that state rather than spinning forever: a request with no producer response
  inside a timeout renders as "no producer connected", not as a hung request.
- **Token cost on automatic generation.** Three suggestions per qualifying message during handoff,
  including for messages the user would never answer. The classifier is the only filter. Watch the
  cost before widening the trigger.
- **The sent-attribution heuristic will be wrong sometimes** — see decision 4. Anything built on it
  must treat it as noisy.

## Alternatives

**Generate in `apps/chat-server/src/llm.ts`.** No dependency on the Hermes gateway; suggestions
work with the app alone. Rejected because the model is not the hard part — the context is, and the
context (voice profile, per-colleague history, cross-thread commitments) lives in Hermes. The output
would be fluent and generic, which is the one failure mode that makes the feature not worth opening.
Also: `assistant/` is scheduled for deletion in PSN-138.

**HTTP callback from chat-server into the Hermes gateway.** A `POST` to the gateway's API when
suggestions are wanted. Rejected: a second URL to configure, a second auth story, and a second
failure mode, to carry bytes over a socket the agent already holds open. The WS hub is already a
fan-out both parties are attached to.

**MCP tool instead of REST routes.** Rejected for the reason in decision 5: ADR-0026's write tools
mutate Teams. Suggestions are local state that never leaves the machine unless the user sends them.
`/prefs` is not an MCP tool for the same reason.

**One row per suggestion instead of a JSON batch.** Rejected: the three texts are alternatives to
each other, so choosing #2 is also a judgement on #1 and #3. Three rows lose that relationship and
make `chosen_idx` meaningless.

**A producer registry / strategy interface.** Rejected as speculative generality with one
implementation. The `producer` TEXT column is the whole abstraction; a second source costs a `WHERE`
clause, not a plugin system.

**Track only `chosen_idx`, not the sent text.** Simpler, and it answers "which one did he pick".
Rejected because it cannot answer "what was wrong with it" — the composer edit is the signal worth
having, and it is unrecoverable after the fact.

## Watch out for

- If `chat.db` starts holding many months of batches, `reply_suggestions` grows without bound —
  it has no sweep. Add one when the row count justifies it, not before.
- `texts` is JSON in a TEXT column, so it is invisible to FTS. Deliberate: suggestions are not
  history and should not pollute message search.
- Decision 6 is a promise about behaviour, not a lock in the code. A future change that adds an
  auto-send path must amend this ADR, not merely add a flag.
