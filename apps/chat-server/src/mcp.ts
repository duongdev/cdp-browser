// Read-only MCP server over chat.db (PSN-114, ADR-0023). Exposes the AI assistant's proven
// retrieval surface (search.ts + unread-overview.ts pure fns) to an external coding agent over
// MCP Streamable HTTP. Same pure fns, different adapter — see D9: the in-app assistant keeps its
// own ai-SDK tool defs (citation tracking + the ai-sdk image-buffer hack can't ride MCP).
//
// Stateless (no Mcp-Session-Id), localhost-only. Per the MCP SDK contract + its own
// simpleStatelessStreamableHttp example, stateless mode builds a FRESH McpServer + transport PER
// REQUEST — reusing either corrupts internal state / causes message-id collisions across clients.
// Construction is cheap (tool registration, no I/O); the pure fns + db/vision/search deps the
// tools close over are shared.

import type BetterSqlite3 from "better-sqlite3"
import type { Hono } from "hono"
import { z } from "zod"
import { runSearch, type SearchFallback } from "./assistant/search-fallback.ts"
import { getUnreadOverview } from "./assistant/unread-overview.ts"
import { listMessageImages } from "./media-store.ts"
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
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js")
  const { WebStandardStreamableHTTPServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
  )
  return { McpServer, WebStandardStreamableHTTPServerTransport }
}

type Db = BetterSqlite3.Database

/** How the MCP server fetches image pixels + lazy captions for `view_image`. Mirrors the
 *  assistant's VisionAccess (provider.media + downscale), injected by the caller. */
export interface McpVision {
  fetchImage(objectId: string): Promise<{ data: Uint8Array; mediaType: string } | null>
  captionImage?(objectId: string): Promise<string | null>
}

const text = (s: unknown) => JSON.stringify(s)
const textContent = (body: unknown) => ({ content: [{ type: "text" as const, text: text(body) }] })

/** Build the read-only MCP server: the 8 retrieval tools. Pure registration — no I/O of its own
 *  beyond the injected `db` + optional `vision`/`search`. Reused across every /mcp request. */
export async function createMcpServer({
  db,
  service,
  vision,
  search,
}: {
  db: Db
  service: string
  vision?: McpVision
  search?: SearchFallback
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

  return server
}

/** DNS-rebinding gate (MCP spec). A browser-originated request carries `Origin: https://evil`;
 *  a non-browser MCP client (curl, Claude Code's fetch) sends none. Allow absent + localhost,
 *  reject every other origin. */
function originAllowed(origin: string | null | undefined): boolean {
  if (!origin) return true
  const o = origin.toLowerCase()
  return (
    o.startsWith("http://localhost") ||
    o.startsWith("http://127.0.0.1") ||
    o.startsWith("http://[::1]")
  )
}

/** Mount the MCP endpoint at `/mcp` (stateless streamable HTTP) on an existing Hono app. Splits
 *  from `index.ts`'s full boot so tests mount it alone on an ephemeral port. */
export async function mountMcp(
  app: Hono,
  opts: { db: Db; service: string; vision?: McpVision; search?: SearchFallback },
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
