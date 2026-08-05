# Hermes session-chat SSE contract (observed)

Captured live from `POST /api/sessions/{id}/chat/stream` on 2026-08-05 against
hermes-agent 0.19.1, after the four local `api_server.py` patches. Raw frames:
`/tmp/sse_frames.jsonl`. Probes: `/tmp/sse_contract.py`, `/tmp/sse_stop.py`.

This is measured, not inferred from source. It supersedes the earlier
source-read mapping table for anything the two disagree on.

## Response headers

```
Content-Type: text/event-stream
Cache-Control: no-cache
X-Accel-Buffering: no
X-Hermes-Session-Id: api_1785921638_2eedca60
Transfer-Encoding: chunked
```

Note: no `x-vercel-ai-ui-message-stream: v1`. The proxy must add it — AI SDK v7
`useChat` requires it on the response it consumes.

## Frame format

```
event: <name>
data: {...}
```

`useChat` parses with `EventSourceParserStream`, which reads `data:` and
**ignores `event:`**. Every Hermes event name lives only in the `event:` line,
so a pass-through proxy loses all type information. The translator must read
`event:` and re-encode the type into the `data` payload as `type`.

## Observed sequence

One turn: text, then a tool call, then more text.

```
run.started
message.started
assistant.delta      x4
tool.progress        x2
tool.started
tool.completed
assistant.completed
run.completed
done
```

`tool.progress` can arrive **before** `tool.started` for the same tool — do not
assume progress implies a started tool is already open.

## Keys per event

| event | keys |
|---|---|
| `run.started` | `run_id, runtime, seq, session_id, ts, user_message` |
| `message.started` | `message, run_id, seq, session_id, ts` |
| `assistant.delta` | `delta, message_id, run_id, seq, session_id, ts` |
| `tool.progress` | `delta, message_id, run_id, seq, session_id, tool_name, ts` |
| `tool.started` | `args, message_id, preview, run_id, seq, session_id, tool_name, ts` |
| `tool.completed` | `args, message_id, preview, run_id, seq, session_id, tool_name, ts` |
| `assistant.completed` | `completed, content, interrupted, message_id, partial, run_id, runtime, seq, session_id, ts` |
| `run.completed` | `completed, message_id, messages, run_id, runtime, seq, session_id, ts, usage` |
| `done` | `run_id, seq, session_id, ts` |

Every frame carries `run_id`, `seq`, `session_id`, `ts`. `seq` is monotonic —
use it for ordering, not arrival time.

`tool.completed` arrives with `args: null` and `preview: null`; the populated
values are on `tool.started`. Correlate by `tool_name` + `message_id`, and note
there is **no per-call tool id** — a turn making two parallel calls to the same
tool cannot be disambiguated from the stream alone.

## system_message

Verified: `{"message": ..., "system_message": "..."}` on the request body is
honoured as an ephemeral system prompt. A probe planting a secret word in
`system_message` had the model return it. This is the seam for context refs
(hướng 2 / ADR-0021 agentic retrieval) — no body-shape change needed.

Unknown body fields are swallowed silently (`body.get(...)` throughout, no
strict validation), so `timeZone` and friends can ride along harmlessly.

## Stop

`POST /v1/runs/{run_id}/stop` → `{"run_id": ..., "status": "stopping"}`.

`run_id` is available from the very first frame (`run.started`), and in fact
from every frame.

Measured: a "count to 300" turn stopped 2.5s in. Post-patch the terminal frames
report `interrupted: true, partial: true, completed: false`. **Pre-patch they
were hardcoded to `false/false/true`** — see
`~/.hermes/patches/api-server-stopped-run-reports-interrupted.patch`. Any client
reading those flags needs the patch, or it will render the interrupt notice as
a normal assistant reply.

## Mapping to AI SDK v7 UIMessageChunk

| Hermes | AI SDK |
|---|---|
| `run.started` | `start` + `start-step` |
| `message.started` | `text-start {id}` |
| `assistant.delta` | `text-delta {id, delta}` |
| `tool.started` | `tool-input-start` + `tool-input-available` |
| `tool.completed` | `tool-output-available` |
| `tool.progress` (`tool_name="_thinking"`) | `reasoning-start` / `reasoning-delta` |
| `assistant.completed` | `text-end {id}` |
| `run.completed` | `finish-step` + `finish` |
| `error` | `error` |
| `done` | `[DONE]` |

The translator is **stateful**: AI SDK requires `start`/`start-step` wrappers and
`text-start`/`text-end` bracketing that have no Hermes equivalent, and needs a
stable `id` per text block (use `message_id`).

`error` was not observed in this capture — the turn succeeded. Its shape is
still unverified.
