// Assistant HTTP surface (t173, ADR-0021 decision 5): session CRUD + the streamed chat route,
// mounted at /api/chat/assistant. The existing web/server.mjs path-prefix proxy forwards it
// untouched; the WS hub stays Teams-deltas-only.

import { randomUUID } from "node:crypto"
import { convertToModelMessages, generateText, type UIMessage } from "ai"
import type BetterSqlite3 from "better-sqlite3"
import { Hono } from "hono"
import {
  enrichModelLimits,
  LlmUnconfiguredError,
  type ModelOption,
  modelHasVision,
  parseModelList,
  readLlmConfig,
  resolveModel,
} from "../llm.ts"
import {
  citationKey,
  stripReasoningRemnants,
  surfacedIdsFromMessages,
  validateCitations,
} from "./citations.ts"
import { planCompaction, transcriptForSummary } from "./compact.ts"
import {
  buildSystemPrompt,
  createAssistantTools,
  createImageBuffer,
  runAgentTurn,
  type SearchFallback,
  type VisionAccess,
} from "./loop.ts"
import {
  addRef,
  appendMessage,
  type ContextRef,
  createSession,
  deleteSession,
  getSession,
  listSessions,
  loadMessages,
  removeRef,
  type StoredUIMessage,
  sanitizePartsForModel,
  updateSession,
} from "./session-store.ts"

type Db = BetterSqlite3.Database

const DEFAULT_SERVICE = "teams"

/** Hard ceiling for one assistant turn (tool loop included). Past this the stream aborts. */
const TURN_TIMEOUT_MS = 180_000

/** Ceiling on one proxy-recorded message. The recording route is reachable by anything that can
 *  reach chat-server, and an unbounded body would let a single POST bloat the session file and
 *  every subsequent reload of that thread. Generous next to a real turn (~10k chars of answer). */
const MAX_RECORDED_PARTS_CHARS = 256_000

export interface AssistantDeps {
  db: Db
  /** Injectable for tests (mock LanguageModel). Default resolves from env per request. */
  getModel?: (modelId?: string | null) => import("ai").LanguageModel
  /** Image access for `view_image` (PSN-104). Absent → the assistant answers from transcriptions
   *  only, which is also what a text-only model gets. */
  vision?: Omit<VisionAccess, "buffer">
  /** Provider + hydrate for `search_messages` substrate fallback (PSN-115 WS-C). Absent → the tool
   *  stays local-only, identical to its pre-WS-C behaviour (hermetic assistant tests rely on this). */
  search?: SearchFallback
}

function errorCodeOf(err: unknown): string {
  if (err instanceof LlmUnconfiguredError) return "llm-unconfigured"
  const name = String((err as Error)?.name || "")
  const msg = String((err as Error)?.message || err || "")
  if (/429|rate.?limit/i.test(msg)) return "llm-rate-limited"
  if (name === "TimeoutError" || /timeout|timed?.?out|aborted/i.test(msg)) return "llm-timeout"
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

  // Limits come from the provider once per process — a model's context window doesn't change
  // under us, and the meter shouldn't pay a round-trip per panel mount. Only a SUCCESSFUL lookup
  // is cached: caching a degraded result would pin the fallback budget until restart after one
  // transient network blip.
  let modelsCache: ModelOption[] | null = null
  async function models(): Promise<ModelOption[]> {
    if (modelsCache) return modelsCache
    const enriched = await enrichModelLimits(parseModelList(), readLlmConfig())
    if (enriched.some((m) => m.contextWindow)) modelsCache = enriched
    return enriched
  }
  app.get("/models", async (c) => c.json({ models: await models() }))

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

  // Persist one message on behalf of a turn that did NOT run here (t179).
  //
  // When HERMES_API_URL is set the turn executes on the Hermes agent and this route never
  // runs, so every side effect the turn route owns inline — persisting the exchange, naming
  // the session, compaction — was silently skipped: measured 0 rows and title=null after two
  // turns through the proxy, meaning a panel reload read back an empty thread while Hermes
  // still held the history. The proxy calls this instead of reimplementing any of it.
  //
  // `maintain` is set on the closing assistant write so title + compaction fire exactly once
  // per exchange, on the same code path the BFF path uses.
  app.post("/sessions/:id/messages", async (c) => {
    const session = getSession(db, c.req.param("id"))
    if (!session) return c.json({ error: "not_found" }, 404)
    const b = await body(c)
    const msg = b.message
    // A bad row here is permanent: it lands in history and reloads forever. Reject rather
    // than store something the panel cannot render.
    if (!msg || typeof msg.id !== "string" || !msg.id) return c.json({ error: "bad_message" }, 400)
    if (msg.role !== "user" && msg.role !== "assistant" && msg.role !== "system")
      return c.json({ error: "bad_role" }, 400)
    if (!Array.isArray(msg.parts)) return c.json({ error: "bad_parts" }, 400)
    if (JSON.stringify(msg.parts).length > MAX_RECORDED_PARTS_CHARS)
      return c.json({ error: "parts_too_large" }, 413)

    appendMessage(db, session.id, {
      id: msg.id,
      role: msg.role,
      parts: msg.parts,
      metadata: msg.metadata,
    })

    if (b.maintain) {
      // Same definition the turn route uses: the just-persisted user message is included,
      // so a first exchange is the one where exactly one user message exists.
      const isFirstExchange =
        loadMessages(db, session.id).filter((m) => m.role === "user").length <= 1
      afterTurnMaintenance(db, session.id, getModel, isFirstExchange).catch(() => {})
    }
    return c.json({ ok: true })
  })

  // ---- context refs (the attach tray) -------------------------------------
  // A ref is PURE: nothing is copied into the transcript (grilled). The system prompt lists what's
  // attached and the model reads the live content with get_context/search — so a ref stays current
  // as new messages land, and removing one genuinely removes that context. Injecting an excerpt
  // (the old behaviour) baked a stale copy into history that un-attaching could never retract.

  app.post("/sessions/:id/context", async (c) => {
    const b = await body(c)
    const session = getSession(db, c.req.param("id"))
    if (!session) return c.json({ error: "not_found" }, 404)
    const scopeKind = b.kind === "folder" || b.kind === "label" ? b.kind : null
    const name = b.name ? String(b.name).trim() : ""
    if (!scopeKind && (!b.convId || !b.title)) return c.json({ error: "missing_ref" }, 400)
    if (scopeKind && !name) return c.json({ error: "missing_ref" }, 400)
    const msgId = b.msgId ? String(b.msgId) : undefined
    // A scope ref (folder/label) carries a NAME, not ids — membership is resolved per question, so
    // it never goes stale.
    const ref: ContextRef = scopeKind
      ? {
          service: b.service || DEFAULT_SERVICE,
          kind: scopeKind,
          name,
          title: name,
          deepLink: "",
        }
      : {
          service: b.service || DEFAULT_SERVICE,
          kind: msgId ? "message" : "chat",
          convId: String(b.convId),
          msgId,
          title: String(b.title),
          sender: b.sender ? String(b.sender).slice(0, 80) : undefined,
          preview: b.preview ? String(b.preview).slice(0, 140) : undefined,
          deepLink: String(b.deepLink || `/chat/c/${b.convId}${msgId ? `?msg=${msgId}` : ""}`),
        }
    const updated = updateSession(db, session.id, {
      contextRefs: addRef(session.contextRefs, ref),
    })
    return c.json({ session: updated })
  })

  app.delete("/sessions/:id/context", async (c) => {
    const session = getSession(db, c.req.param("id"))
    if (!session) return c.json({ error: "not_found" }, 404)
    // Accept the target on the query string (a DELETE body isn't reliably forwarded by proxies).
    const convId = c.req.query("convId")
    const msgId = c.req.query("msgId") || undefined
    const kind = c.req.query("kind")
    const name = c.req.query("name")
    const isScope = (kind === "folder" || kind === "label") && !!name
    if (!isScope && !convId) return c.json({ error: "missing_ref" }, 400)
    const updated = updateSession(db, session.id, {
      contextRefs: removeRef(session.contextRefs, isScope ? { kind, name } : { convId, msgId }),
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
    // Marker rows (a model switch) are notes FOR THE USER, not conversation — sending them would
    // read to the model as an instruction it was given, so they are stored and rendered but never
    // sent. Filtered after the slice so they still count toward the watermark's indices.
    const live = stored
      .slice(session.summaryUptoIdx)
      .filter((m) => m.role === "user" || m.role === "assistant")
    const surfaced = surfacedIdsFromMessages(stored)
    // `view_image` only exists for a model that takes image input — a text-only model calling it
    // would 400 mid-turn (or silently drop the image and confidently describe nothing).
    const imageBuffer = createImageBuffer()
    const canSee =
      !!deps.vision && modelHasVision(sessionModel || readLlmConfig()?.model || "", await models())
    const tools = createAssistantTools(
      db,
      service,
      (convId, msgId) => surfaced.add(citationKey({ convId, msgId })),
      canSee && deps.vision ? { ...deps.vision, buffer: imageBuffer } : undefined,
      deps.search,
    )
    const modelMessages = await convertToModelMessages(
      live.map((m) => ({ role: m.role, parts: sanitizePartsForModel(m.parts) })) as Omit<
        UIMessage,
        "id"
      >[],
      { tools, ignoreIncompleteToolCalls: true },
    )

    const result = runAgentTurn({
      // A provider that stops producing must not hang the panel forever — the stream aborts and
      // surfaces as a typed error the client can retry (steering: "freezes forever").
      abortSignal: AbortSignal.timeout(TURN_TIMEOUT_MS),
      model,
      system: buildSystemPrompt({
        summary: session.summary,
        contextRefs: session.contextRefs,
        vision: canSee,
        // The browser sends its own zone with each turn; the server clock is UTC in prod.
        timeZone: typeof b.timeZone === "string" ? b.timeZone : undefined,
      }),
      messages: modelMessages,
      tools,
      images: canSee ? imageBuffer : undefined,
      onFinish: ({ totalUsage }) => {
        const n = totalUsage?.totalTokens
        if (Number.isFinite(n)) updateSession(db, sessionId, { addTokens: n as number })
      },
    })
    // Un-awaited: generation completes + persists even if the tab disconnects (decision 4).
    result.consumeStream()

    return result.toUIMessageStreamResponse({
      originalMessages: stored as unknown as UIMessage[],
      // Every assistant turn needs its OWN id. Without this the SDK reuses the last original
      // assistant message's id, and `appendMessage` (which dedups by message id) then OVERWROTE
      // the previous reply instead of appending — turns 2+ silently replaced turn 1's answer, so a
      // reloaded session read back as user/assistant/user/user with replies missing.
      generateMessageId: () => `a-${randomUUID()}`,
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
