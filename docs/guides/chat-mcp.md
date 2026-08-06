# Chat MCP server

The chat BFF (`apps/chat-server`) exposes an MCP server at `/mcp`. A local coding agent
(Claude Code, any MCP client) connects to it to work with your own synced Teams chats — search, read
a thread, list conversations, see unread, look at an inline image, and reply on your behalf. See
[ADR-0024](../adr/0024-chat-mcp-server.md), [ADR-0026](../adr/0026-mcp-write-tools.md) (write tools)
and [ADR-0025](../adr/0025-mcp-over-tailnet.md) (reachable on the tailnet origin).

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

**Read tools (8):**

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

**Write tools (6)** — registered only when the server is built with a provider. Without one the
server is exactly the 8 read tools above. Every write goes to Teams first and touches the local row
only once the service accepts it (ADR-0022), so a failure surfaces as an error instead of the two
silently diverging.

| Tool | What it does |
|---|---|
| `send_reply` | Send a message to a conversation. Returns the new `msgId`, so a follow-up `edit_message` / `delete_message` can address what was just sent. |
| `react_to_message` | Add or remove a reaction. |
| `edit_message` | Rewrite one of your own messages. |
| `delete_message` | Delete one of your own messages. |
| `mark_read` | Mark a conversation read up to a timestamp — clears the unread badge on your other devices too. |
| `mark_unread` | Flag a conversation unread from a timestamp on. |

Each carries MCP annotations (`readOnlyHint: false`; `destructiveHint` on edit + delete) so a client
can prompt before running one.

`quotes` and `mentions` are deliberately absent: a native Teams reply needs the `<blockquote>`
markup built in the renderer workspace, and a bare reference would post a reply pointer with no
visible quote.

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

- **Writes are real.** `send_reply`, `edit_message` and `delete_message` reach the actual Teams
  conversation. Point an agent at the mock stack, not a live session, unless you mean it.
- **Tailnet, no auth.** `/mcp` is reverse-proxied on `portal.dp.dustin.one`, which resolves to a
  Tailscale CGNAT address — the DNS record is public, the route is not. It sits behind the same
  boundary as `/api/chat/*`, which has been able to send as you all along. A per-request `Origin`
  check rejects browser cross-origin requests (MCP-spec DNS-rebinding defense): a request with no
  `Origin` (every non-browser MCP client) or a loopback one passes, everything else gets 403.
  **If that origin ever points at a routable IP, `/mcp` must come off the proxy in the same change.**
- **Stateless.** No `Mcp-Session-Id`; each request is independent.
- **Single-service.** Teams today; the `service` discriminator keeps a second provider additive.

## Verification

Unit + protocol-contract + real-MCP-client e2e run in `pnpm test` (`apps/chat-server/src/mcp.test.ts`)
against an in-memory db. The manual gate is a real Claude Code turn over the mock stack — see
`docs/testing/chat-qa.md` Area 11.
