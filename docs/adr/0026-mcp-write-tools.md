# ADR-0026: Chat MCP write tools

- **Status:** Accepted
- **Date:** 2026-08-03
- **Amends:** ADR-0024 (decision 3 — read-only) and ADR-0025 (decision 2 — `/mcp` stays read-only)

## Context

ADR-0024 built `/mcp` as a **read-only** MCP server: eight retrieval tools over `chat.db`. Its
decision 3 reads: *"Read-only. No send/react/edit/mark-read tool. The issue's constraint ('self-chat
only, no mutations on other users' threads') holds by construction."* The scope is also in that
ADR's title, and its security posture leaned on it.

Two things have changed since.

**1. The isolation premise was already false.** ADR-0025 established that `portal.dp.dustin.one`
resolves to a Tailscale CGNAT address and has always been tailnet-only, and that `/api/chat/*` —
which includes `reply`, `react`, `edit`, `delete`, `mark-read`, `mark-unread` — was reverse-proxied
on that origin the whole time. Anyone who can reach `/mcp` can already reach `/api/chat/reply` and
send a Teams message as the user, with no MCP involved.

**2. The read/write split forces a worse integration.** PSN-131's goal is Hermes replacing the
in-app assistant. An agent that can read a thread but not answer in it has to hand every write back
across a second, differently-shaped transport (raw REST, hand-rolled auth, separate error mapping).
That is more moving parts guarding a door that is already open.

So the question is not "should the tailnet be able to write to chat" — it can, today, via REST. It
is "should the agent's write path be the same audited surface as its read path, or a second one
bolted alongside".

### What is actually new

Two things this genuinely changes, stated plainly rather than argued away.

**Who initiates.** REST writes are driven by a human clicking in the panel. MCP writes are driven by
an LLM deciding. Same capability, different failure mode — a confused model can send the wrong text
to the wrong conversation, and `delete_message` is not recoverable from our side. Capability parity
is the argument for the *transport*; it is not an argument that autonomous writes are free.

**The "self-chat only" constraint is dropped.** ADR-0024 decision 3 held that constraint *by
construction* — there were no write tools, so it could not be violated. These tools take a `convId`
like any other, so an agent can write into a real shared thread. Re-imposing self-chat-only here was
considered and rejected: the panel does not enforce it, PSN-131's whole point is Hermes answering in
real conversations, and a constraint the neighbouring surface ignores is theatre, not a control. The
real control is the human confirming the send — which is why the annotations in decision 4 exist and
why `send_reply`'s description tells the agent to confirm text and target first.

## Decision

Extend `/mcp` with **six write tools**, mirroring the existing REST writes one-for-one:

| Tool | Provider call | Local store effect |
|---|---|---|
| `send_reply` | `sendReply` | none (echo arrives via sweep/WS) |
| `react_to_message` | `react` | none |
| `edit_message` | `edit` | none |
| `delete_message` | `delete` | none |
| `mark_read` | `markRead` | `markConversationRead` |
| `mark_unread` | `markUnread` | `markConversationUnread` |

1. **Same provider methods as `routes.ts`, not a parallel path.** The write tools call the identical
   `ChatProvider` methods the REST routes call. No new provider surface, no second implementation of
   send/edit semantics to drift out of sync.

2. **Write-through order preserved.** For read state, the provider write goes first and the local
   row is only touched once the service accepts it — the rule ADR-0022 set for `/mark-read`. A
   failure surfaces as an error rather than letting local and service state silently diverge.

3. **Writes are opt-in at construction.** `createMcpServer` takes an optional `write` dep. Omitted,
   not one write tool is registered and the server is byte-identical to ADR-0024's. The read-only
   configuration remains a real, reachable state — that is what keeps `mcp.test.ts`'s existing
   surface assertions meaningful, and what a future locked-down deployment would use.

4. **MCP tool annotations carry the risk class.** Every write tool sets `readOnlyHint: false`;
   `delete_message` sets `destructiveHint: true`, and `mark_read`/`mark_unread`/`react_to_message`
   set `idempotentHint: true`. This is the MCP-native channel through which a client decides what to
   confirm with its human. We publish the metadata; we do not assume any particular client honours
   it.

5. **No new auth, no new gate.** The `Origin` gate is unchanged. Adding a token to `/mcp` while
   `/api/chat/reply` sits unauthenticated on the same origin secures the wrong door. When the chat
   surface gets auth it gets it in one change, across both.

6. **Uploads stay out.** `upload-image` / `upload-images` / `upload-file` are not exposed. Base64
   blobs through JSON-RPC is a bad shape, and no current workflow needs an agent to originate file
   uploads. Revisit when one does.

## Consequences

- The agent's read and write paths are one surface with one error mapping, one origin gate, one
  place to add auditing.
- **An LLM with tailnet access can now send, edit, and delete Teams messages as the user.** This
  changes who initiates, not what is possible. Deletion is irreversible from our side.
- `mcp.ts` grows the provider dep it previously did not need. It is no longer strictly a projection
  of `chat.db`.
- ADR-0024's title is now wrong. Left as-is: ADRs are append-only, and this ADR's `Amends` line plus
  0024's Status line are the pointer.

## Watch out for

- If `/mcp` is ever exposed on a routable origin, this ADR and ADR-0025 both become void together —
  the write tools must come off in the same change that widens the origin.
- If a client is observed acting on `send_reply` without human confirmation in a way the user did
  not intend, the mitigation is a confirmation step server-side (a pending-write queue), not more
  annotations. Annotations are advisory by design.
- `send_reply`'s echo arrives asynchronously via the sweep/WS path. An agent that sends and then
  immediately calls `get_context` may not see its own message yet. Do not "fix" this by writing a
  synthetic local row — that reintroduces the divergence decision 2 exists to prevent.
