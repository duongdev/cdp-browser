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
  listScopes,
  resolvePerson,
  resolveScope,
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
        "Full-text search over all synced chat messages. Vietnamese-safe: ASCII queries match diacritic text. Use short keyword queries; filter by sender id (resolve names via resolve_person first), conversation, a folder/label scope (pass the convIds from resolve_scope), or time range (ms epoch). For 'who mentioned me' / 'what was I tagged in', set mentionsMe:true — do NOT search the user's own name, which matches people merely talking about them and misses mentions under a different display name.",
      inputSchema: z.object({
        query: z.string().min(1),
        sender: z.string().optional(),
        convId: z.string().optional(),
        convIds: z.array(z.string()).optional(),
        after: z.number().optional(),
        before: z.number().optional(),
        mentionsMe: z.boolean().optional(),
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
        "List conversations by name (fold-matched substring; empty query lists newest). Pass convIds from resolve_scope to list only one folder/label. Returns conversation ids for use in other tools.",
      inputSchema: z.object({
        query: z.string().optional(),
        convIds: z.array(z.string()).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      execute: async (input) => listConversationsByQuery(db, service, input),
    }),
    list_scopes: tool({
      description:
        "The user's own folders and labels (their manual organisation of conversations), with conversation counts. Call this when the question names a grouping you don't recognise.",
      inputSchema: z.object({}),
      execute: async () => listScopes(db, service),
    }),
    resolve_scope: tool({
      description:
        "Resolve a folder or label the user named ('the FWD folder', 'anything labelled urgent') to its conversation ids — pass those as convIds to search_messages / list_conversations. Fold-matched, so casing and diacritics don't matter. When the name matches nothing it returns matched:null plus every real folder and label; ask the user which one rather than guessing.",
      inputSchema: z.object({ name: z.string().min(1) }),
      execute: async (input) => {
        const hit = resolveScope(db, service, input.name)
        return hit ? { matched: hit } : { matched: null, available: listScopes(db, service) }
      },
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
    "The user organises conversations into their own folders and labels. When a question names one ('in my FWD folder', 'the urgent ones'), call resolve_scope and pass the convIds it returns — do not guess which conversations belong.",
    "CITATIONS: when your answer draws on a specific message, append an inline marker [msg:{convId}:{msgId}] right after the claim, using the exact convId and msgId from tool results. Markers referencing ids you did not see in tool results are stripped.",
    "Answer in the user's language (mirror Vietnamese with Vietnamese). Be concise.",
    `Current time: ${new Date(opts.now ?? Date.now()).toISOString()}`,
  ]
  if (opts.summary) {
    lines.push("", "Summary of the earlier part of this session:", opts.summary)
  }
  const refs = opts.contextRefs || []
  if (refs.length) {
    // Soft bias (grilled): attached items are the priority, not a hard filter — "did anyone ELSE
    // mention this?" must stay answerable. Nothing is injected into the transcript, so the model
    // MUST read them with a tool before leaning on them.
    lines.push(
      "",
      "The user attached these for this question. Read them first with get_context (they are references, not quoted here), prefer them over anything else, and only search wider when the question clearly calls for it:",
      ...refs.map((r) =>
        r.msgId
          ? `- message from ${r.sender || "someone"} in "${r.title}" (convId ${r.convId}, msgId ${r.msgId})`
          : `- the whole conversation "${r.title}" (convId ${r.convId})`,
      ),
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
  /** Hard ceiling for the whole turn — a stalled provider aborts instead of hanging (steering). */
  abortSignal?: AbortSignal
}

/** One streamed assistant turn. Thin assembly so tests drive it with a mock LanguageModel. */
export function runAgentTurn(opts: AgentTurnOpts) {
  return streamText({
    model: opts.model,
    system: opts.system,
    messages: opts.messages,
    tools: opts.tools,
    stopWhen: stepCountIs(STEP_CAP),
    abortSignal: opts.abortSignal,
    onFinish: opts.onFinish,
  })
}
