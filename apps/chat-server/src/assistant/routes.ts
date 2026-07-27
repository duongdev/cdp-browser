// Assistant HTTP surface (t173, ADR-0021 decision 5): session CRUD + the streamed chat route,
// mounted at /api/chat/assistant. The existing web/server.mjs path-prefix proxy forwards it
// untouched; the WS hub stays Teams-deltas-only.

import { convertToModelMessages, generateText, type UIMessage } from "ai"
import type BetterSqlite3 from "better-sqlite3"
import { Hono } from "hono"
import { LlmUnconfiguredError, parseModelList, readLlmConfig, resolveModel } from "../llm.ts"
import { getContextWindow } from "../search.ts"
import {
  citationKey,
  stripReasoningRemnants,
  surfacedIdsFromMessages,
  validateCitations,
} from "./citations.ts"
import { planCompaction, transcriptForSummary } from "./compact.ts"
import { buildSystemPrompt, createAssistantTools, runAgentTurn } from "./loop.ts"
import {
  appendMessage,
  createSession,
  deleteSession,
  getSession,
  listSessions,
  loadMessages,
  type StoredUIMessage,
  sanitizePartsForModel,
  updateSession,
} from "./session-store.ts"

type Db = BetterSqlite3.Database

const DEFAULT_SERVICE = "teams"

export interface AssistantDeps {
  db: Db
  /** Injectable for tests (mock LanguageModel). Default resolves from env per request. */
  getModel?: (modelId?: string | null) => import("ai").LanguageModel
}

function errorCodeOf(err: unknown): string {
  if (err instanceof LlmUnconfiguredError) return "llm-unconfigured"
  const msg = String((err as Error)?.message || err || "")
  if (/429|rate.?limit/i.test(msg)) return "llm-rate-limited"
  if (/timeout|timed?.?out|aborted/i.test(msg)) return "llm-timeout"
  return "llm-error"
}

export function createAssistantRoutes(deps: AssistantDeps) {
  const app = new Hono()
  const { db } = deps
  const getModel =
    deps.getModel ??
    ((modelId?: string | null) => resolveModel(readLlmConfig(), modelId || undefined))

  app.onError((err, c) => {
    const code = errorCodeOf(err)
    return c.json({ error: code }, code === "llm-unconfigured" ? 503 : 500)
  })

  // ---- assistant prefs (t176) ---------------------------------------------
  // The draft-reply tone guidance blob. User-editable, DB-only (`settings` table, service
  // "assistant") — never committed to the repo (OSS boundary).

  app.get("/prefs", (c) => {
    const r = db
      .prepare("SELECT value FROM settings WHERE service = 'assistant' AND key = 'voice'")
      .get() as { value: string } | undefined
    return c.json({ voice: r?.value ?? "" })
  })

  app.post("/prefs", async (c) => {
    const b = await body(c)
    const voice = typeof b.voice === "string" ? b.voice.slice(0, 2000) : ""
    db.prepare(
      "INSERT INTO settings (service, key, value) VALUES ('assistant', 'voice', ?) ON CONFLICT(service, key) DO UPDATE SET value = excluded.value",
    ).run(voice)
    return c.json({ voice })
  })

  // ---- models (t177) -------------------------------------------------------
  // The curated LLM_MODELS list (id[:label] pairs), never the raw router dump.

  app.get("/models", (c) => c.json({ models: parseModelList() }))

  // ---- session CRUD --------------------------------------------------------

  app.get("/sessions", (c) => c.json({ sessions: listSessions(db) }))

  app.post("/sessions", async (c) => {
    const b = await body(c)
    return c.json({ session: createSession(db, { title: b.title, model: b.model }) })
  })

  app.patch("/sessions/:id", async (c) => {
    const b = await body(c)
    const session = updateSession(db, c.req.param("id"), { title: b.title, model: b.model })
    if (!session) return c.json({ error: "not_found" }, 404)
    return c.json({ session })
  })

  app.delete("/sessions/:id", (c) => {
    deleteSession(db, c.req.param("id"))
    return c.json({ ok: true })
  })

  app.get("/sessions/:id/messages", (c) => {
    const session = getSession(db, c.req.param("id"))
    if (!session) return c.json({ error: "not_found" }, 404)
    return c.json({ session, messages: loadMessages(db, session.id) })
  })

  // ---- context refs ("ask AI about this") ---------------------------------
  // Appends the descriptor to context_refs (pinned one-line into every later system prompt) and
  // injects the referenced content ONCE as a user message part (re-fetchable via tools after
  // compaction).

  app.post("/sessions/:id/context", async (c) => {
    const b = await body(c)
    const session = getSession(db, c.req.param("id"))
    if (!session) return c.json({ error: "not_found" }, 404)
    if (!b.convId || !b.title) return c.json({ error: "missing_ref" }, 400)
    const service = b.service || DEFAULT_SERVICE
    const ref = {
      service,
      convId: String(b.convId),
      msgId: b.msgId ? String(b.msgId) : undefined,
      title: String(b.title),
      deepLink: String(b.deepLink || `/chat/c/${b.convId}${b.msgId ? `?msg=${b.msgId}` : ""}`),
    }
    const window = getContextWindow(db, service, {
      convId: ref.convId,
      aroundMsgId: ref.msgId,
      limit: ref.msgId ? 10 : 6,
    })
    const excerpt = window
      .map((m) => `${m.senderName || "?"}: ${m.deleted ? "[deleted]" : m.text}`)
      .join("\n")
    appendMessage(db, session.id, {
      id: `ctx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: "user",
      parts: [
        {
          type: "text",
          text: `[Attached context: ${ref.title} (convId ${ref.convId}${ref.msgId ? `, msgId ${ref.msgId}` : ""})]\n${excerpt || "(no synced messages)"}`,
        },
      ],
      metadata: { contextRef: ref },
    })
    const updated = updateSession(db, session.id, {
      contextRefs: [...session.contextRefs, ref],
    })
    return c.json({ session: updated })
  })

  // ---- the chat route ------------------------------------------------------

  app.post("/:sessionId", async (c) => {
    const sessionId = c.req.param("sessionId")
    const session = getSession(db, sessionId)
    if (!session) return c.json({ error: "not_found" }, 404)
    const b = await body(c)
    const service = b.service || DEFAULT_SERVICE

    // Resolving the model can throw typed (llm-unconfigured) BEFORE any stream starts. A stored
    // model id that's no longer in the curated list falls back to the env default (t177) — the FE
    // shows the non-blocking notice; no mid-stream switch (a turn finishes on the model it started).
    const curated = parseModelList()
    const sessionModel =
      session.model && (curated.length === 0 || curated.some((m) => m.id === session.model))
        ? session.model
        : null
    const model = getModel(sessionModel)

    // Persist the incoming user message (id-dedup makes a retry idempotent).
    const incoming: UIMessage[] = Array.isArray(b.messages)
      ? b.messages
      : b.message
        ? [b.message]
        : []
    const lastUser = [...incoming].reverse().find((m) => m?.role === "user")
    if (lastUser?.id && Array.isArray(lastUser.parts)) {
      appendMessage(db, sessionId, {
        id: lastUser.id,
        role: "user",
        parts: lastUser.parts,
        metadata: lastUser.metadata,
      })
    }

    const stored = loadMessages(db, sessionId)
    const isFirstExchange = stored.filter((m) => m.role === "user").length <= 1

    // Compaction separates sent from stored: only messages past the watermark go to the model.
    const live = stored.slice(session.summaryUptoIdx)
    const surfaced = surfacedIdsFromMessages(stored)
    const tools = createAssistantTools(db, service, (convId, msgId) =>
      surfaced.add(citationKey({ convId, msgId })),
    )
    const modelMessages = await convertToModelMessages(
      live.map((m) => ({ role: m.role, parts: sanitizePartsForModel(m.parts) })) as Omit<
        UIMessage,
        "id"
      >[],
      { tools, ignoreIncompleteToolCalls: true },
    )

    const result = runAgentTurn({
      model,
      system: buildSystemPrompt({ summary: session.summary, contextRefs: session.contextRefs }),
      messages: modelMessages,
      tools,
      onFinish: ({ totalUsage }) => {
        const n = totalUsage?.totalTokens
        if (Number.isFinite(n)) updateSession(db, sessionId, { addTokens: n as number })
      },
    })
    // Un-awaited: generation completes + persists even if the tab disconnects (decision 4).
    result.consumeStream()

    return result.toUIMessageStreamResponse({
      originalMessages: stored as unknown as UIMessage[],
      onError: errorCodeOf,
      onEnd: ({ responseMessage, isAborted }) => {
        if (isAborted || !responseMessage) return
        // Validate citations on every text part before the message is persisted.
        const citations: { convId: string; msgId: string }[] = []
        const parts = (responseMessage.parts as { type?: string; text?: string }[]).map((p) => {
          if (p?.type !== "text" || typeof p.text !== "string") return p
          const v = validateCitations(stripReasoningRemnants(p.text), surfaced)
          citations.push(...v.citations)
          return { ...p, text: v.text }
        })
        appendMessage(db, sessionId, {
          id: responseMessage.id,
          role: "assistant",
          parts,
          metadata: { ...(responseMessage.metadata as object), citations },
        })
        afterTurnMaintenance(db, sessionId, getModel, isFirstExchange).catch(() => {})
      },
    })
  })

  return app
}

/** Fire-and-forget post-turn work: title after the first exchange, compaction past the budget.
 *  Failure leaves the fallback title / an uncompacted session — never surfaces to the client. */
async function afterTurnMaintenance(
  db: Db,
  sessionId: string,
  getModel: (modelId?: string | null) => import("ai").LanguageModel,
  isFirstExchange: boolean,
): Promise<void> {
  const session = getSession(db, sessionId)
  if (!session) return
  const messages = loadMessages(db, sessionId)

  if (isFirstExchange && !session.title) {
    const firstUserText = firstText(messages.find((m) => m.role === "user"))
    const fallback = firstUserText.slice(0, 40) || "New session"
    try {
      const r = await generateText({
        model: getModel(session.model),
        prompt: `Write a title for this chat (max 50 chars, same language as the user, no quotes):\n\n${transcriptForSummary(messages.slice(0, 4)).slice(0, 2000)}`,
      })
      const title = r.text
        .trim()
        .replace(/^["']|["']$/g, "")
        .slice(0, 50)
      updateSession(db, sessionId, { title: title || fallback })
    } catch {
      updateSession(db, sessionId, { title: fallback })
    }
  }

  const fresh = getSession(db, sessionId)
  if (!fresh) return
  const plan = planCompaction(messages, fresh.summaryUptoIdx, fresh.summary)
  if (!plan.needed) return
  try {
    const chunk = transcriptForSummary(messages.slice(plan.fromIdx, plan.uptoIdx))
    const r = await generateText({
      model: getModel(fresh.model),
      prompt: `Condense this chat transcript into a compact summary preserving facts, names, cited message ids, and decisions. Prior summary (extend it):\n${fresh.summary || "(none)"}\n\nTranscript:\n${chunk.slice(0, 60_000)}`,
    })
    if (r.text.trim())
      updateSession(db, sessionId, { summary: r.text.trim(), summaryUptoIdx: plan.uptoIdx })
  } catch {
    // stay uncompacted; retry next turn
  }
}

function firstText(msg: StoredUIMessage | undefined): string {
  if (!msg) return ""
  for (const p of msg.parts) {
    const t = (p as { text?: string })?.text
    if (typeof t === "string" && t.trim()) return t.trim()
  }
  return ""
}

// biome-ignore lint/suspicious/noExplicitAny: request bodies are dynamic contract shapes
async function body(c: { req: { json: () => Promise<unknown> } }): Promise<any> {
  try {
    return (await c.req.json()) ?? {}
  } catch {
    return {}
  }
}
