// The agent loop (t173, ADR-0021 decisions 2–3): streamText + read-only retrieval tools over
// chat.db, step-capped. Tools are thin zod wrappers over t171's search functions — compact,
// token-efficient results, every row stamped (convId, msgId) so citations can validate. The tool
// set is strictly read-only over chat data: no send/react/edit/mark-read tool exists, so the loop
// cannot mutate conversations even if prompted to.

import { type LanguageModel, stepCountIs, streamText, type ToolSet, tool } from "ai"
import type BetterSqlite3 from "better-sqlite3"
import { z } from "zod"
import type { HydrateEngine } from "../hydrate.ts"
import { listMessageImages } from "../media-store.ts"
import type { ChatProvider, ProviderSearchHit } from "../providers/provider.ts"
import {
  getContextWindow,
  listConversationsByQuery,
  listScopes,
  resolvePerson,
  resolveScope,
  type SearchHit,
  searchMessages,
} from "../search.ts"
import { type ContextRef, isScopeRef } from "./session-store.ts"
import { getUnreadOverview } from "./unread-overview.ts"

type Db = BetterSqlite3.Database

export const STEP_CAP = 8

/** Cap on how long `search_messages` waits for the hydrate pipeline to land substrate rows in
 *  chat.db before re-querying. The assistant benefits from real rows (full snippet + sender id +
 *  FTS relevance) but a slow keeper tab can't stall the turn. Substrate-only rows still go to the
 *  model as best-effort after the wait. */
const HYDRATE_WAIT_MS = 3000

/** When wired, `search_messages` falls back to the provider's substrate search + hydrate pipeline
 *  on a thin/zero local page (PSN-115 WS-C). Either field without the other is meaningless, so they
 *  travel as a pair. */
export interface SearchFallback {
  provider: ChatProvider
  hydrate: HydrateEngine
}

/** Read-only retrieval tools. `onSurfaced` receives every (convId, msgId) a tool result exposes —
 *  the citation validator's allow set. */
export function createAssistantTools(
  db: Db,
  service: string,
  onSurfaced: (convId: string, msgId: string) => void,
  vision?: VisionAccess,
  search?: SearchFallback,
): ToolSet {
  return {
    ...(vision ? { view_image: viewImageTool(db, service, onSurfaced, vision) } : {}),
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
        const limit = input.limit ?? 20
        const localHits = searchMessages(db, { ...input, service, limit })
        for (const h of localHits) onSurfaced(h.convId, h.msgId)

        // Fast path: no substrate search wired, or local FTS already filled the page — identical to
        // the pre-WS-C tool, returning the plain array the existing tests + mock model expect.
        if (!search || localHits.length >= limit) {
          return localHits.map(hitRow)
        }

        // Thin/zero local → one substrate call. A failure (auth/rate-limit/shape drift) degrades
        // honestly to local-only instead of crashing the turn.
        let substrateHits: ProviderSearchHit[] = []
        let degraded = false
        try {
          const page = await search.provider.searchMessages(input.query, { sort: "relevance" })
          substrateHits = page.rows
        } catch {
          degraded = true
        }
        if (degraded) {
          return {
            rows: localHits.map(hitRow),
            note: "upstream search unavailable; showing synced results only",
          }
        }

        // Hydrate substrate hits that aren't local yet, then re-query FTS so the model sees real
        // rows (full snippet, sender id, FTS relevance). The wait is bounded — substrate-only rows
        // still go to the model best-effort after it.
        const have = new Set(localHits.map((h) => `${h.convId}\n${h.msgId}`))
        const missing = substrateHits.filter((h) => !have.has(`${h.convId}\n${h.msgId}`))
        if (missing.length) {
          await Promise.race([
            search.hydrate.hydrateHits(missing).catch(() => {}),
            new Promise<void>((r) => setTimeout(r, HYDRATE_WAIT_MS)),
          ])
        }

        // Re-query on the same filters; widen the net so freshly-hydrated rows beyond the original
        // `limit` still surface (relevance order keeps the best ones on top).
        const reLocal = searchMessages(db, { ...input, service, limit: Math.max(limit, 20) })
        const reHave = new Set(reLocal.map((h) => `${h.convId}\n${h.msgId}`))
        for (const h of reLocal) onSurfaced(h.convId, h.msgId)

        const rows: ReturnType<typeof hitRow>[] = reLocal.map(hitRow)
        // Substrate-only rows (didn't hydrate in time) still go in — they're citable because the
        // surfaced set was just updated. Marked `substrate:true` so the model knows it's a preview.
        for (const h of substrateHits) {
          if (rows.length >= limit) break
          if (reHave.has(`${h.convId}\n${h.msgId}`)) continue
          rows.push({
            convId: h.convId,
            msgId: h.msgId,
            sender: h.sender,
            ts: h.ts,
            snippet: h.preview,
            substrate: true,
          })
          onSurfaced(h.convId, h.msgId)
        }
        return { rows: rows.slice(0, limit) }
      },
    }),
    get_context: tool({
      description:
        "Read a window of messages from one conversation: around a specific message (aroundMsgId), before a timestamp (beforeTs, ms), or the newest messages. A row's `repliesTo` carries the message it quotes (with the parent's msgId) — pass that id back as aroundMsgId to follow a reply chain.",
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
          ...(m.quotes?.length ? { repliesTo: m.quotes } : {}),
          ...(m.images?.length ? { images: m.images } : {}),
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

// ---- images (PSN-104) ------------------------------------------------------
// A message's inline images reach the model two ways. Cheap and always available: the transcription
// made at ingest, which rides along in every tool row as `images[].caption`. Expensive and opt-in:
// the raw pixels, via `view_image` — registered ONLY for a model that accepts image input.
//
// The pixels cannot ride back as the tool's own result: @ai-sdk/openai-compatible JSON.stringifies
// a multi-modal tool output into the `role:"tool"` message, so the image would arrive as base64
// text. They are buffered instead and injected as a `role:"user"` message on the next step, which
// the provider does map to a real image part.

export interface FetchedImage {
  data: Uint8Array
  mediaType: string
}

/** How the loop gets pixels — injected by the routes (provider fetch + downscale + caption), plus
 *  the per-turn buffer the fetched bytes land in. */
export interface VisionAccess {
  fetchImage(objectId: string): Promise<FetchedImage | null>
  /** Transcribe on demand, for an image whose caption never got made (lazy backfill). */
  captionImage?(objectId: string): Promise<string | null>
  buffer: ImageBuffer
}

export interface PendingImage extends FetchedImage {
  convId: string
  msgId: string
  index: number
}

/** Collects images the model asked for during a turn. Everything seen so far is re-injected on
 *  every subsequent step: `prepareStep` overrides one step only, so an image dropped after its step
 *  would vanish from context the moment the model made one more tool call. */
export function createImageBuffer() {
  const seen: PendingImage[] = []
  return {
    add(img: PendingImage) {
      if (
        !seen.some((s) => s.convId === img.convId && s.msgId === img.msgId && s.index === img.index)
      )
        seen.push(img)
    },
    get size() {
      return seen.length
    },
    /** The extra message to append to a step's prompt, or null when nothing has been fetched. */
    // biome-ignore lint/suspicious/noExplicitAny: a ModelMessage, typed structurally by the SDK
    message(): any | null {
      if (!seen.length) return null
      return {
        role: "user",
        content: [
          {
            type: "text",
            text: `Images you asked to see, in order: ${seen
              .map((s) => `[msg:${s.convId}:${s.msgId}] image#${s.index}`)
              .join(", ")}`,
          },
          ...seen.map((s) => ({ type: "file", data: s.data, mediaType: s.mediaType })),
        ],
      }
    },
  }
}

export type ImageBuffer = ReturnType<typeof createImageBuffer>

function viewImageTool(
  db: Db,
  service: string,
  onSurfaced: (convId: string, msgId: string) => void,
  vision: VisionAccess,
) {
  return tool({
    description:
      "Look at an inline image in a message — use it when the message text shows an [image#N] marker and the transcription is missing, incomplete, or the question is about what the image LOOKS like (layout, colours, a chart, who is in a photo). The image is attached to the conversation on the next step, so continue reasoning after calling this.",
    inputSchema: z.object({
      convId: z.string().min(1),
      msgId: z.string().min(1),
      /** 1-based, matching the `[image#N]` marker; omit for the message's only/first image. */
      index: z.number().int().min(1).optional(),
    }),
    execute: async ({ convId, msgId, index }) => {
      const rows = listMessageImages(db, service, convId, msgId)
      if (!rows.length) return { error: "no images in that message" }
      const row = index ? rows.find((r) => r.index === index) : rows[0]
      if (!row) return { error: `that message has ${rows.length} image(s)` }
      onSurfaced(convId, msgId)
      const img = await vision.fetchImage(row.objectId)
      if (!img) {
        // The pixels are gone/unreachable; the transcription is the honest fallback.
        const caption = row.caption ?? (await vision.captionImage?.(row.objectId)) ?? null
        return caption
          ? {
              attached: false,
              caption,
              note: "image could not be loaded; this is its transcription",
            }
          : { error: "image could not be loaded" }
      }
      vision.buffer.add({ convId, msgId, index: row.index, ...img })
      return { attached: true, note: "the image is attached below — describe what you see" }
    },
  })
}

/** Local FTS row → the compact tool-result shape the model consumes. Pure, shared by the fast and
 *  fallback paths so the row shape never drifts between them. */
function hitRow(h: SearchHit) {
  return {
    convId: h.convId,
    msgId: h.msgId,
    sender: h.senderName || h.senderId || "?",
    ts: h.ts,
    snippet: h.snippet,
    // What this message replies to, when it quotes one (Teams inlines the parent). The parent's
    // msgId is real — read it with get_context({aroundMsgId}) before relying on it.
    ...(h.quotes?.length ? { repliesTo: h.quotes } : {}),
    ...(h.images?.length ? { images: h.images } : {}),
  }
}

/** How the assistant TALKS to this user (PSN-104 steering) — the same three rule sets he runs on his
 *  own coding agents, so this panel doesn't feel like a different, chattier assistant:
 *  his global `~/CLAUDE.md` (terse, answer first, no emoji, one thread at a time, simple English,
 *  mirror Vietnamese, blockers stated up front), the `caveman` skill (drop articles/filler/hedging,
 *  fragments fine, every technical term and error string kept verbatim), and `i-have-adhd`
 *  (ayghri/i-have-adhd: lead with the action, bounded numbered steps, five-item cap, no
 *  preamble/recap/closer, rank options instead of prescribing one).
 *
 *  Distilled, not pasted — the sources are ~15KB combined and this rides every turn. The carve-outs
 *  are load-bearing: quoted message text and anything drafted FOR a colleague must stay normal
 *  prose, or the assistant hands him clipped caveman-speak to send to his team. */
const RESPONSE_STYLE: string[] = [
  "STYLE — the reader is one person with ADHD who wants terse output. Every answer, not just the first:",
  "- Lead with the answer or the next action. No preamble ('Let me…', 'Great question', 'Looking at your…'), no recap of what you just did, no closing pleasantry ('Hope this helps', 'Let me know').",
  "- Drop filler, hedging adverbs and pleasantries. Fragments are fine. Keep EVERY technical fact, name, id, number and quote exact — this is compression, not omission.",
  "- Bad news first. A blocker, a wrong assumption or 'this can't be answered from the synced history' goes in the opening line, never buried at the end.",
  "- Multi-step work → a numbered list, one bounded action per step, five items max. Past five, split 'now' vs 'later'.",
  "- Finish one thread before raising another. A second issue goes at the end as its own one-line question.",
  "- State outcomes matter-of-factly, including bad ones ('nothing matched that in the last 7 days'). Never 'Uh oh' or 'There seems to be a problem'.",
  "- No emoji. No decorative tables — a table only when the data is genuinely tabular.",
  "- Several ways forward → rank them and say which you'd pick. Never a menu with no recommendation.",
  "- If something is still open, end with ONE concrete next action.",
  "NEVER compress: text quoted from a real message (verbatim), a drafted reply or any wording meant for someone else (normal, complete prose in the user's own voice), and warnings before anything irreversible.",
  "If the user asks you to explain or walk through something, explain fully — still no preamble, still no closer.",
]

/** "Today", in the user's zone, spelled out for the model (PSN-104). A UTC clock made it call this
 *  morning "yesterday" for anyone east of Greenwich, and every relative-time question ("what did I
 *  miss today", "since this morning") inherited that error. The day boundaries are given as ms
 *  epoch so the model can pass them straight to `search_messages`'s after/before instead of doing
 *  timezone arithmetic itself. */
export function timeContext(now: number, timeZone: string): string[] {
  const zone = safeZone(timeZone)
  const fmt = (o: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: zone, ...o }).format(new Date(now))
  const today = fmt({ year: "numeric", month: "2-digit", day: "2-digit" })
  // Midnight local, expressed in ms epoch: what the local date means as an absolute instant.
  const startOfDay = Date.parse(`${today}T00:00:00${offsetOf(now, zone)}`)
  return [
    `TIME: now is ${fmt({ dateStyle: "full", timeStyle: "short" })} in ${zone} (the user's timezone) — epoch ms ${now}.`,
    `"Today" means ${today} LOCAL: epoch ms ${startOfDay} to ${startOfDay + 86_400_000}. "Yesterday" is the 24h before that.`,
    "Message `ts` values are epoch ms — compare them against those numbers, never against a UTC calendar date, and state times in the user's timezone.",
  ]
}

/** The zone's UTC offset at `now` as `+07:00`, from the formatter itself (no DST table). */
function offsetOf(now: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(new Date(now))
    .find((p) => p.type === "timeZoneName")
  const m = /GMT([+-]\d{2}:\d{2})/.exec(parts?.value || "")
  return m ? m[1] : "Z"
}

/** A client can send any string; an invalid zone would throw inside Intl. */
function safeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone })
    return timeZone
  } catch {
    return "UTC"
  }
}

export function buildSystemPrompt(opts: {
  summary?: string | null
  contextRefs?: ContextRef[]
  now?: number
  /** IANA zone the question was asked from (the browser's). Defaults to the server's. */
  timeZone?: string
  /** The picked model can see images — `view_image` exists (PSN-104). */
  vision?: boolean
}): string {
  const lines = [
    "You are the assistant inside CDP Chats, answering questions over the user's own synced chat history (Microsoft Teams).",
    "Use the tools to find real messages before answering. Never invent message content.",
    "A message that replies to another carries `repliesTo` (the quoted sender + excerpt + the parent's msgId). Those words are the PARENT's, not the replier's — never attribute them to the replier, and follow the chain with get_context(aroundMsgId) when the answer depends on what was replied to.",
    "The user organises conversations into their own folders and labels. When a question names one ('in my FWD folder', 'the urgent ones'), call resolve_scope and pass the convIds it returns — do not guess which conversations belong.",
    opts.vision
      ? "IMAGES: a message containing an [image#N] marker has an inline image. Tool rows carry `images[]` with each one's transcription — prefer that. Call view_image only when the transcription is missing or the question is about how the image LOOKS; the picture is then attached on the next step."
      : "IMAGES: a message containing an [image#N] marker has an inline image. Tool rows carry `images[]` with its transcription — that text is all you can see of it, so answer from it and say so when it is missing.",
    "CITATIONS: when your answer draws on a specific message, append an inline marker [msg:{convId}:{msgId}] right after the claim, using the exact convId and msgId from tool results. Markers referencing ids you did not see in tool results are stripped.",
    "Answer in the user's language — mirror Vietnamese with Vietnamese. Simple words; he reads English as a second language.",
    ...RESPONSE_STYLE,
    ...timeContext(
      opts.now ?? Date.now(),
      opts.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    ),
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
      "The user attached these for this question. Read them first (they are references, not quoted here) — conversations and messages with get_context, folders and labels by resolving them to convIds first. Prefer them over anything else, and only search wider when the question clearly calls for it:",
      ...refs.map((r) =>
        isScopeRef(r)
          ? `- everything in the ${r.kind} "${r.name}" (call resolve_scope with that name, then pass its convIds to search_messages / list_conversations)`
          : r.msgId
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
  /** Images `view_image` has fetched this turn; appended to every later step's prompt (PSN-104). */
  images?: ImageBuffer
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
    // Pixels can only reach the model on a user message (the openai-compatible mapping drops them
    // from a tool result), so every step after a view_image call re-appends what has been fetched.
    prepareStep: opts.images
      ? ({ messages }) => {
          const extra = opts.images?.message()
          return extra ? { messages: [...messages, extra] } : {}
        }
      : undefined,
  })
}
