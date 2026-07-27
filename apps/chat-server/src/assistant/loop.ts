// The agent loop (t173, ADR-0021 decisions 2–3): streamText + read-only retrieval tools over
// chat.db, step-capped. Tools are thin zod wrappers over t171's search functions — compact,
// token-efficient results, every row stamped (convId, msgId) so citations can validate. The tool
// set is strictly read-only over chat data: no send/react/edit/mark-read tool exists, so the loop
// cannot mutate conversations even if prompted to.

import { type LanguageModel, stepCountIs, streamText, type ToolSet, tool } from "ai"
import type BetterSqlite3 from "better-sqlite3"
import { z } from "zod"
import {
  getContextWindow,
  listConversationsByQuery,
  resolvePerson,
  searchMessages,
} from "../search.ts"
import type { ContextRef } from "./session-store.ts"
import { getUnreadOverview } from "./unread-overview.ts"

type Db = BetterSqlite3.Database

export const STEP_CAP = 8

/** Read-only retrieval tools. `onSurfaced` receives every (convId, msgId) a tool result exposes —
 *  the citation validator's allow set. */
export function createAssistantTools(
  db: Db,
  service: string,
  onSurfaced: (convId: string, msgId: string) => void,
): ToolSet {
  return {
    search_messages: tool({
      description:
        "Full-text search over all synced chat messages. Vietnamese-safe: ASCII queries match diacritic text. Use short keyword queries; filter by sender id (resolve names via resolve_person first), conversation, or time range (ms epoch).",
      inputSchema: z.object({
        query: z.string().min(1),
        sender: z.string().optional(),
        convId: z.string().optional(),
        after: z.number().optional(),
        before: z.number().optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      execute: async (input) => {
        const hits = searchMessages(db, { ...input, service })
        for (const h of hits) onSurfaced(h.convId, h.msgId)
        return hits.map((h) => ({
          convId: h.convId,
          msgId: h.msgId,
          sender: h.senderName || h.senderId || "?",
          ts: h.ts,
          snippet: h.snippet,
        }))
      },
    }),
    get_context: tool({
      description:
        "Read a window of messages from one conversation: around a specific message (aroundMsgId), before a timestamp (beforeTs, ms), or the newest messages.",
      inputSchema: z.object({
        convId: z.string().min(1),
        aroundMsgId: z.string().optional(),
        beforeTs: z.number().optional(),
        limit: z.number().int().min(1).max(60).optional(),
      }),
      execute: async (input) => {
        const win = getContextWindow(db, service, input)
        for (const m of win) onSurfaced(input.convId, m.msgId)
        return win.map((m) => ({
          convId: input.convId,
          msgId: m.msgId,
          sender: m.senderName || m.senderId || "?",
          ts: m.ts,
          text: m.deleted ? "[deleted]" : m.text,
        }))
      },
    }),
    list_conversations: tool({
      description:
        "List conversations by name (fold-matched substring; empty query lists newest). Returns conversation ids for use in other tools.",
      inputSchema: z.object({
        query: z.string().optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      execute: async (input) => listConversationsByQuery(db, service, input),
    }),
    resolve_person: tool({
      description: "Resolve a person's name to their sender id candidates.",
      inputSchema: z.object({ name: z.string().min(1) }),
      execute: async (input) => resolvePerson(db, service, input),
    }),
    get_unread_overview: tool({
      description:
        "The user's unread conversations: per-conversation unread counts + short excerpts of the unread messages, oldest first. Muted conversations are excluded unless includeMuted. Read-only — never changes read state.",
      inputSchema: z.object({ includeMuted: z.boolean().optional() }),
      execute: async (input) => {
        const overview = getUnreadOverview(db, service, input)
        for (const conv of overview) {
          for (const e of conv.excerpts) onSurfaced(conv.convId, e.msgId)
        }
        return overview
      },
    }),
  }
}

export function buildSystemPrompt(opts: {
  summary?: string | null
  contextRefs?: ContextRef[]
  now?: number
}): string {
  const lines = [
    "You are the assistant inside CDP Chats, answering questions over the user's own synced chat history (Microsoft Teams).",
    "Use the tools to find real messages before answering. Never invent message content.",
    "CITATIONS: when your answer draws on a specific message, append an inline marker [msg:{convId}:{msgId}] right after the claim, using the exact convId and msgId from tool results. Markers referencing ids you did not see in tool results are stripped.",
    "Answer in the user's language (mirror Vietnamese with Vietnamese). Be concise.",
    `Current time: ${new Date(opts.now ?? Date.now()).toISOString()}`,
  ]
  if (opts.summary) {
    lines.push("", "Summary of the earlier part of this session:", opts.summary)
  }
  const refs = opts.contextRefs || []
  if (refs.length) {
    lines.push(
      "",
      "The user attached these as context (re-read via get_context when needed):",
      ...refs.map((r) => `- ${r.title} (convId ${r.convId}${r.msgId ? `, msgId ${r.msgId}` : ""})`),
    )
  }
  return lines.join("\n")
}

export interface AgentTurnOpts {
  model: LanguageModel
  system: string
  // biome-ignore lint/suspicious/noExplicitAny: ModelMessage[] from convertToModelMessages
  messages: any
  tools: ToolSet
  onFinish?: Parameters<typeof streamText>[0]["onFinish"]
}

/** One streamed assistant turn. Thin assembly so tests drive it with a mock LanguageModel. */
export function runAgentTurn(opts: AgentTurnOpts) {
  return streamText({
    model: opts.model,
    system: opts.system,
    messages: opts.messages,
    tools: opts.tools,
    stopWhen: stepCountIs(STEP_CAP),
    onFinish: opts.onFinish,
  })
}
