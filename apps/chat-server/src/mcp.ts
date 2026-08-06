// MCP server over chat.db (PSN-114, ADR-0023/0024; write tools added by ADR-0026). Exposes the AI
// assistant's proven retrieval surface (search.ts + unread-overview.ts pure fns) to an external
// coding agent over MCP Streamable HTTP. Same pure fns, different adapter — see D9: the in-app
// assistant keeps its own ai-SDK tool defs (citation tracking + the ai-sdk image-buffer hack can't
// ride MCP). Writes go through the same ChatProvider methods routes.ts calls, so send/edit
// semantics have one implementation, not two.
//
// Stateless (no Mcp-Session-Id); reachable on the tailnet origin per ADR-0025. Per the MCP SDK
// contract + its own simpleStatelessStreamableHttp example, stateless mode builds a FRESH
// McpServer + transport PER
// REQUEST — reusing either corrupts internal state / causes message-id collisions across clients.
// Construction is cheap (tool registration, no I/O); the pure fns + db/vision/search deps the
// tools close over are shared.

import type BetterSqlite3 from "better-sqlite3"
import type { Hono } from "hono"
import { z } from "zod"
import { runSearch, type SearchFallback } from "./assistant/search-fallback.ts"
import { getUnreadOverview } from "./assistant/unread-overview.ts"
import { listMessageImages } from "./media-store.ts"
import type { ChatProvider } from "./providers/provider.ts"
import {
  getContextWindow,
  listConversationsByQuery,
  listScopes,
  resolvePerson,
  resolveScope,
} from "./search.ts"

// Lazy imports — the MCP SDK is a chat-server-only dep (not in the Electron allowlist), so pulling
// it at module top would break `main.js` if this file ever leaked across the workspace boundary.
// Dynamic import also keeps test files that stub the pure fns from forcing the SDK onto the import
// graph at typecheck time.
async function loadSdk() {
  const { McpServer, ResourceTemplate } = await import("@modelcontextprotocol/sdk/server/mcp.js")
  const { WebStandardStreamableHTTPServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
  )
  return { McpServer, ResourceTemplate, WebStandardStreamableHTTPServerTransport }
}

type Db = BetterSqlite3.Database

/** How the MCP server fetches image pixels + lazy captions for `view_image`. Mirrors the
 *  assistant's VisionAccess (provider.media + downscale), injected by the caller. */
export interface McpVision {
  fetchImage(objectId: string): Promise<{ data: Uint8Array; mediaType: string } | null>
  captionImage?(objectId: string): Promise<string | null>
}

/** Write access for the mutating tools (ADR-0026). The same `ChatProvider` methods `routes.ts`
 *  calls — one implementation of send/edit semantics, not two that can drift. Omit this dep and no
 *  write tool is registered at all: the read-only server of ADR-0024 stays a reachable state. */
export interface McpWrite {
  provider: Pick<
    ChatProvider,
    "sendReply" | "react" | "edit" | "delete" | "markRead" | "markUnread"
  >
  /** Local read-state mirror, applied only AFTER the provider accepts (ADR-0022 write-through). */
  markConversationRead(convId: string, ts: number): void
  markConversationUnread(convId: string, ts: number): void
}

const text = (s: unknown) => JSON.stringify(s)
const textContent = (body: unknown) => ({ content: [{ type: "text" as const, text: text(body) }] })

/** Build the MCP server: the 8 retrieval tools, plus the 6 write tools when `write` is supplied
 *  (ADR-0026 — omit it and the surface is exactly ADR-0024's read-only one). Pure registration — no
 *  I/O of its own beyond the injected deps. Rebuilt per request (stateless mode, see above). */
export async function createMcpServer({
  db,
  service,
  vision,
  search,
  write,
}: {
  db: Db
  service: string
  vision?: McpVision
  search?: SearchFallback
  write?: McpWrite
}) {
  const { McpServer } = await loadSdk()
  const server = new McpServer({ name: "cdp-chats", version: "0.1.0" })

  server.registerTool(
    "search_messages",
    {
      description:
        "Full-text search over all synced chat messages, with a live upstream fallback so a query reaches ALL Teams history, not just what's synced locally. Vietnamese-safe: ASCII queries match diacritic text. Short keyword queries; filter by sender id (resolve names via resolve_person first), conversation, or time range (ms epoch). For 'who mentioned me' set mentionsMe:true — do NOT search the user's own name (matches people talking about them, misses mentions under other display names). Rows carry `substrate:true` when they came from upstream but aren't hydrated yet (a preview); `degraded:true` + `note` when upstream was unavailable.",
      inputSchema: {
        query: z.string().min(1),
        sender: z.string().optional(),
        convId: z.string().optional(),
        convIds: z.array(z.string()).optional(),
        after: z.number().optional(),
        before: z.number().optional(),
        mentionsMe: z.boolean().optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    async (input) => textContent(await runSearch(db, service, input, search)),
  )

  server.registerTool(
    "get_context",
    {
      description:
        "Read a window of messages from one conversation: around a message (aroundMsgId), before a ts (beforeTs, ms), or the newest. A row's `repliesTo` carries the message it quotes (with the parent's msgId) — pass that back as aroundMsgId to follow a reply chain.",
      inputSchema: {
        convId: z.string().min(1),
        aroundMsgId: z.string().optional(),
        beforeTs: z.number().optional(),
        limit: z.number().int().min(1).max(60).optional(),
      },
    },
    async (input) => {
      const win = getContextWindow(db, service, input)
      return textContent(
        win.map((m) => ({
          convId: input.convId,
          msgId: m.msgId,
          sender: m.senderName || m.senderId || "?",
          ts: m.ts,
          text: m.deleted ? "[deleted]" : m.text,
          ...(m.quotes?.length ? { repliesTo: m.quotes } : {}),
          ...(m.images?.length ? { images: m.images } : {}),
        })),
      )
    },
  )

  server.registerTool(
    "list_conversations",
    {
      description:
        "List conversations by name (fold-matched substring; empty query lists newest). Pass convIds from resolve_scope to list one folder/label only. Returns conversation ids for the other tools.",
      inputSchema: {
        query: z.string().optional(),
        convIds: z.array(z.string()).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    async (input) => textContent(listConversationsByQuery(db, service, input)),
  )

  server.registerTool(
    "list_scopes",
    {
      description:
        "The user's own folders and labels (manual conversation organisation), with conversation counts. Call when the question names a grouping you don't recognise.",
      inputSchema: {},
    },
    async () => textContent(listScopes(db, service)),
  )

  server.registerTool(
    "resolve_scope",
    {
      description:
        "Resolve a folder/label the user named ('the FWD folder') to its conversation ids — pass those as convIds to search_messages / list_conversations. Fold-matched (casing/diacritics don't matter). No match returns matched:null plus every real folder/label; ask the user which one rather than guessing.",
      inputSchema: { name: z.string().min(1) },
    },
    async (input) => {
      const hit = resolveScope(db, service, input.name)
      return textContent(
        hit ? { matched: hit } : { matched: null, available: listScopes(db, service) },
      )
    },
  )

  server.registerTool(
    "resolve_person",
    {
      description: "Resolve a person's name to their sender id candidates.",
      inputSchema: { name: z.string().min(1) },
    },
    async (input) => textContent(resolvePerson(db, service, input)),
  )

  server.registerTool(
    "get_unread_overview",
    {
      description:
        "The user's unread conversations: per-conversation unread counts + short excerpts, oldest first. Muted conversations excluded unless includeMuted. Read-only — never changes read state.",
      inputSchema: { includeMuted: z.boolean().optional() },
    },
    async (input) => textContent(getUnreadOverview(db, service, input)),
  )

  // view_image: native MCP image content (no ai-sdk buffer hack — that's assistant-only, D9).
  if (vision) {
    server.registerTool(
      "view_image",
      {
        description:
          "Look at an inline image in a message — use when the message text shows an [image#N] marker and the transcription is missing/incomplete, or the question is about what the image LOOKS like (layout, colours, a chart, who is in a photo). Returns the image bytes inline.",
        inputSchema: {
          convId: z.string().min(1),
          msgId: z.string().min(1),
          index: z.number().int().min(1).optional(),
        },
      },
      async ({ convId, msgId, index }) => {
        const rows = listMessageImages(db, service, convId, msgId)
        if (!rows.length) return textContent({ error: "no images in that message" })
        const row = index ? rows.find((r) => r.index === index) : rows[0]
        if (!row) return textContent({ error: `that message has ${rows.length} image(s)` })
        const img = await vision.fetchImage(row.objectId)
        if (!img) {
          const caption = row.caption ?? (await vision.captionImage?.(row.objectId)) ?? null
          return textContent(
            caption
              ? { caption, note: "image could not be loaded; this is its transcription" }
              : { error: "image could not be loaded" },
          )
        }
        return {
          content: [
            {
              type: "image" as const,
              data: Buffer.from(img.data).toString("base64"),
              mimeType: img.mediaType,
            },
            { type: "text" as const, text: `[msg:${convId}:${msgId}] image #${row.index}` },
          ],
        }
      },
    )
  }

  // ---- writes (ADR-0026) ----------------------------------------------------------------------
  // Opt-in: no `write` dep => not one of these is registered, and the server is exactly ADR-0024's.
  // Each is a thin pass-through to the SAME ChatProvider method routes.ts calls. `readOnlyHint:
  // false` and the destructive/idempotent hints are the MCP-native channel a client uses to decide
  // what to confirm with its human — advisory by design, so we publish them and assume nothing.
  if (write) {
    const { provider } = write

    server.registerTool(
      "send_reply",
      {
        description:
          "Send a message to a conversation AS THE USER. Real people see it immediately and it cannot be unsent (only deleted, which leaves a tombstone). Confirm the exact text and the target convId with the user before calling. Returns the new message's `msgId` — pass it to edit_message/delete_message to correct your own send. To answer a specific message, quote it in your own words: native reply-threading and @-mentions are not available here.",
        inputSchema: {
          convId: z.string().min(1),
          text: z.string(),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      },
      // Text only. A native reply (`quotes`) is not just a msgId list: Teams renders it from a
      // matching `<blockquote itemtype=".../Reply">` that `chat/src/lib/reply-quote.ts` builds in
      // the RENDERER workspace, and mentions need per-token wire spans in the same html. Passing
      // bare refs from here would post a message with a reply pointer and no visible quote — worse
      // than not offering it. Wire them when that builder is shared across the workspace boundary.
      //
      // Deliberately does NOT attribute to a reply-suggestion batch (PSN-145), unlike POST /reply.
      // That column measures what the USER sent after picking a suggestion — his edit is the
      // signal. A send from here is the agent acting on its own, so pairing it with his choice
      // would record the agent agreeing with itself and quietly poison the one metric the table
      // exists for.
      async ({ convId, text: body }) => {
        const res = await provider.sendReply(convId, body)
        // SendResult.ts IS the new message's id (Teams ids are epoch-ms; the mock mirrors that, and
        // thread-view.tsx uses `r.ts` as the id when reconciling its optimistic bubble). Nothing in
        // the name says so, so surface it as `msgId` — otherwise an agent that just sent a message
        // has no way to edit or delete it without re-reading the conversation to guess which is his.
        return textContent({ ...res, msgId: res.ts })
      },
    )

    server.registerTool(
      "react_to_message",
      {
        description:
          "Add or remove an emoji reaction on a message, as the user. Set remove:true to take a reaction back.",
        inputSchema: {
          convId: z.string().min(1),
          msgId: z.string().min(1),
          key: z.string().min(1).describe("Reaction key, e.g. 'like', 'heart', 'laugh'."),
          remove: z.boolean().optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      },
      async ({ convId, msgId, key, remove }) => {
        await provider.react(convId, msgId, key, !!remove)
        return textContent({ ok: true })
      },
    )

    server.registerTool(
      "edit_message",
      {
        description:
          "Rewrite one of the USER'S OWN already-sent messages. The service marks it edited for everyone. Editing someone else's message will fail at the provider.",
        inputSchema: {
          convId: z.string().min(1),
          msgId: z.string().min(1),
          text: z.string(),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      },
      async ({ convId, msgId, text: body }) => {
        await provider.edit(convId, msgId, body)
        return textContent({ ok: true })
      },
    )

    server.registerTool(
      "delete_message",
      {
        description:
          "Delete one of the USER'S OWN sent messages. IRREVERSIBLE — the content cannot be recovered from here. Always confirm with the user first, and read the message (get_context) before deleting so you are certain of the target.",
        inputSchema: { convId: z.string().min(1), msgId: z.string().min(1) },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      },
      async ({ convId, msgId }) => {
        await provider.delete(convId, msgId)
        return textContent({ ok: true })
      },
    )

    // Read state is written THROUGH to the service (ADR-0022): provider first, local row only once
    // the service accepted — a failure surfaces as an error instead of the two silently diverging.
    server.registerTool(
      "mark_read",
      {
        description:
          "Mark a conversation read up to a timestamp (ms epoch), syncing read state to the service — it clears the unread badge on the user's other devices too.",
        inputSchema: {
          convId: z.string().min(1),
          ts: z.number().describe("Read up to this ms-epoch timestamp."),
          msgId: z.string().optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      },
      async ({ convId, ts, msgId }) => {
        await provider.markRead(convId, msgId ?? "", ts)
        write.markConversationRead(convId, ts)
        return textContent({ ok: true })
      },
    )

    server.registerTool(
      "mark_unread",
      {
        description:
          "Flag a conversation unread from a timestamp (ms epoch) on, syncing to the service. Use to leave something for the user to look at.",
        inputSchema: { convId: z.string().min(1), ts: z.number() },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      },
      async ({ convId, ts }) => {
        await provider.markUnread(convId, ts)
        write.markConversationUnread(convId, ts)
        return textContent({ ok: true })
      },
    )
  }

  // ---- resources (D5): addressable chat data the agent can browse / reference by URI ----------
  const { ResourceTemplate } = await loadSdk()
  server.registerResource(
    "conversations",
    "chat://conversations",
    {
      description:
        "All synced conversations (newest first). Each entry's id is the convId the other tools take.",
      mimeType: "application/json",
    },
    async () => ({
      contents: [
        {
          uri: "chat://conversations",
          mimeType: "application/json",
          text: text(listConversationsByQuery(db, service, {})),
        },
      ],
    }),
  )
  server.registerResource(
    "conversation",
    new ResourceTemplate("chat://conversation/{convId}", { list: undefined }),
    {
      description:
        "A recent-messages window of one conversation, by convId. Use get_context for paging or reply-chain walks.",
      mimeType: "application/json",
    },
    async (_uri, { convId }) => ({
      contents: [
        {
          uri: `chat://conversation/${convId}`,
          mimeType: "application/json",
          text: text(getContextWindow(db, service, { convId: String(convId) })),
        },
      ],
    }),
  )

  // ---- prompts (D5): canned templates pointing at the read-only tools -------------------------
  server.registerPrompt(
    "catch-up-on-unread",
    { description: "Summarise what the user missed across unread conversations." },
    async () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: "Read my unread conversations (call get_unread_overview), then give a terse catch-up: per conversation, who + the gist. Lead with anything that needs a response. Skip muted noise.",
          },
        },
      ],
    }),
  )
  server.registerPrompt(
    "summarize-conversation",
    {
      description: "Summarise one conversation by id.",
      argsSchema: {
        convId: z
          .string()
          .min(1)
          .describe("Conversation id (from list_conversations or chat://conversations)"),
      },
    },
    async ({ convId }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Read conversation ${convId} (call get_context with that convId, page older with beforeTs if needed) and summarise: what's decided, what's open, who owes what. Plain prose, no filler.`,
          },
        },
      ],
    }),
  )
  server.registerPrompt(
    "find-decision",
    {
      description: "Find a decision made in chat about a topic.",
      argsSchema: { topic: z.string().min(1).describe("What to look for") },
    },
    async ({ topic }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Search chats for a decision about "${topic}" (call search_messages with the key terms; follow reply chains via get_context's aroundMsgId where it matters). Report the decision, who made it, and the message id. Say plainly if nothing was decided.`,
          },
        },
      ],
    }),
  )

  return server
}

/** Loopback hosts allowed to drive `/mcp` from a browser. `new URL().hostname` keeps the brackets
 *  on an IPv6 literal, so `[::1]` is the form to match. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"])

/** DNS-rebinding gate (MCP spec). A browser-originated request carries `Origin: https://evil`;
 *  a non-browser MCP client (curl, Claude Code's fetch) sends none. Allow absent + loopback,
 *  reject every other origin.
 *
 *  Matches the parsed **hostname**, never a string prefix: `http://localhost.evil.com` starts with
 *  `http://localhost` but is an attacker's domain, and since ADR-0025 put `/mcp` behind the tailnet
 *  proxy and ADR-0026 gave it write tools, that bypass would hand a hostile page send/edit/delete. */
export function originAllowed(origin: string | null | undefined): boolean {
  if (!origin) return true
  let host: string
  try {
    const url = new URL(origin)
    if (url.protocol !== "http:") return false
    host = url.hostname.toLowerCase()
  } catch {
    return false // unparseable Origin is not a loopback one
  }
  return LOOPBACK_HOSTS.has(host)
}

/** Mount the MCP endpoint at `/mcp` (stateless streamable HTTP) on an existing Hono app. Splits
 *  from `index.ts`'s full boot so tests mount it alone on an ephemeral port. */
export async function mountMcp(
  app: Hono,
  opts: {
    db: Db
    service: string
    vision?: McpVision
    search?: SearchFallback
    write?: McpWrite
  },
): Promise<void> {
  app.all("/mcp", async (c) => {
    if (!originAllowed(c.req.header("origin")))
      return c.json({ jsonrpc: "2.0", error: { code: -32600, message: "forbidden origin" } }, 403)
    const { WebStandardStreamableHTTPServerTransport } = await loadSdk()
    // Stateless mode = a fresh server + fresh transport PER REQUEST (per the SDK's own
    // simpleStatelessStreamableHttp example): reusing either across requests corrupts internal
    // state / causes message-id collisions. Construction is cheap (tool registration, no I/O); the
    // pure fns + db/search deps it closes over are shared.
    const server = await createMcpServer(opts)
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    })
    await server.connect(transport)
    return await transport.handleRequest(c.req.raw)
  })
}
