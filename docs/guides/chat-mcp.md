# Chat MCP server

The chat BFF (`apps/chat-server`) exposes a **read-only MCP server** at `/mcp`. A local coding agent
(Claude Code, any MCP client) connects to it to query your own synced Teams chats — search, read a
thread, list conversations, see unread, look at an inline image. See [ADR-0024](../adr/0024-chat-mcp-server.md).

It reuses the AI assistant's retrieval surface verbatim, so an agent reaches the same data the
in-app assistant + global search do — including PSN-115's **hybrid search** (local FTS + Teams
Substrate fallback + hydrate), so a query reaches all Teams history, not just the synced subset.

## Connect Claude Code

With the BFF running locally (`pnpm chat:bff`, default `:7810`):

```sh
claude mcp add --transport http chats http://localhost:7810/mcp
```

Then in any Claude Code session: `What did I miss today?`, `Summarize the <topic> discussion`,
`Find the decision about X`. The agent calls the MCP tools under the hood.

Remove with `claude mcp remove chats`.

## What it exposes

**Tools (8, read-only):**

| Tool | What it does |
|---|---|
| `search_messages` | Full-text search (Vietnamese-safe). Local FTS fast path + upstream Substrate fallback + hydrate-on-miss. `substrate:true` rows are previews; `degraded:true` + `note` when upstream was unavailable. |
| `get_context` | Read a message window in one conversation: around a message, before a ts, or the newest. Walk reply chains via `aroundMsgId`. |
| `list_conversations` | List conversations by name (fold-matched; empty lists newest). |
| `list_scopes` | Your folders + labels, with conversation counts. |
| `resolve_scope` | Resolve a folder/label name to conversation ids. |
| `resolve_person` | Resolve a person's name to sender id candidates. |
| `get_unread_overview` | Unread conversations: counts + excerpts, muted excluded unless `includeMuted`. Never changes read state. |
| `view_image` | Look at an inline image (`[image#N]` marker) — returns the bytes inline. |

**Resources (2):**

- `chat://conversations` — all synced conversations (newest first).
- `chat://conversation/{convId}` — a recent-messages window of one conversation.

**Prompts (3):**

- `catch-up-on-unread` — summarise what you missed.
- `summarize-conversation` (`convId`) — summarise one thread.
- `find-decision` (`topic`) — find a decision made in chat.

## Local quickstart (no tenant)

The whole chat product runs on a laptop against fixtures — no Teams tenant, nothing deployed:

```sh
nvm use 24                       # better-sqlite3 ABI
pnpm chat:mock                   # boots BFF + web on 7910/7900 (mock provider)
claude mcp add --transport http chats http://localhost:7910/mcp
```

Then open a Claude Code session and ask about the fixture data. Simulate an inbound message with
`pnpm chat:mock:say -d '{"text":"hi"}'` and re-ask — the agent sees it live.

## Posture

- **Read-only.** No send/react/edit/mark-read tool. The self-chat / no-mutations constraint holds by
  construction.
- **Localhost, no auth.** `/mcp` is not reverse-proxied to the public origin, so it never leaves the
  host. Remote access rides Tailscale (encrypted transport). A per-request `Origin` header check
  rejects browser cross-origin requests (MCP-spec DNS-rebinding defense).
- **Stateless.** No `Mcp-Session-Id`; each request is independent.
- **Single-service.** Teams today; the `service` discriminator keeps a second provider additive.

## Verification

Unit + protocol-contract + real-MCP-client e2e run in `pnpm test` (`apps/chat-server/src/mcp.test.ts`)
against an in-memory db. The manual gate is a real Claude Code turn over the mock stack — see
`docs/testing/chat-qa.md` Area 11.
