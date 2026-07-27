// Assistant session persistence (t173, ADR-0021 decision 4). Sessions + one row per UIMessage in
// chat.db. UIMessage JSON is not stable across AI SDK majors, so every row stamps `sdk_major` and
// loading is tolerant: junk parts JSON drops the message, never crashes; unknown part types are
// kept in storage but filtered before they reach `convertToModelMessages`.

import { randomUUID } from "node:crypto"
import type BetterSqlite3 from "better-sqlite3"

type Db = BetterSqlite3.Database

export const SDK_MAJOR = 7

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ai_sessions (
    id               TEXT PRIMARY KEY,
    title            TEXT,
    model            TEXT,
    created_at       INTEGER,
    updated_at       INTEGER,
    summary          TEXT,
    summary_upto_idx INTEGER DEFAULT 0,
    total_tokens     INTEGER DEFAULT 0,
    context_refs     TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS ai_messages (
    id         TEXT NOT NULL,
    session_id TEXT NOT NULL,
    idx        INTEGER NOT NULL,
    role       TEXT NOT NULL,
    parts      TEXT,
    metadata   TEXT,
    sdk_major  INTEGER,
    created_at INTEGER,
    PRIMARY KEY (session_id, idx)
  )`,
]

export function migrateAssistant(db: Db): void {
  for (const stmt of SCHEMA) db.exec(stmt)
}

/** Something the user attached to the session. Pure reference — nothing is copied into the
 *  transcript, so removing one genuinely removes that context (the model re-reads live via
 *  get_context/search when it needs the content).
 *
 *  Four kinds, two shapes: a conversation-shaped ref (`chat`/`message`) points at ids, a
 *  SCOPE-shaped one (`folder`/`label`) points at a NAME (PSN-104). A scope stays live by design —
 *  the folder's membership is resolved at question time, so a conversation filed into it after the
 *  attach is in scope without re-attaching. */
export interface ContextRef {
  service: string
  kind: "chat" | "message" | "folder" | "label"
  /** chat/message only. */
  convId?: string
  msgId?: string
  /** folder/label only: the scope's name, as the user typed/assigned it. */
  name?: string
  /** The chip's label: a conversation title, or the folder/label name. */
  title: string
  /** Message chips only: the sender + a short excerpt, so two messages from one chat differ. */
  sender?: string
  preview?: string
  deepLink: string
}

export function isScopeRef(ref: {
  kind?: string
}): ref is ContextRef & { kind: "folder" | "label"; name: string } {
  return ref.kind === "folder" || ref.kind === "label"
}

/** Identity of an attachment: a scope by (kind, name), anything else by (convId, msgId). */
export function refKey(ref: {
  kind?: string
  name?: string
  convId?: string
  msgId?: string
}): string {
  return isScopeRef(ref)
    ? `scope\n${ref.kind}\n${ref.name}`
    : `msg\n${ref.convId ?? ""}\n${ref.msgId ?? ""}`
}

/** Two refs are the same attachment when they carry the same key. */
export function sameRef(a: ContextRef, b: ContextRef): boolean {
  return refKey(a) === refKey(b)
}

/** Add a ref, ignoring a duplicate. Returns the same array reference when nothing changed. */
export function addRef(refs: ContextRef[], ref: ContextRef): ContextRef[] {
  return refs.some((r) => sameRef(r, ref)) ? refs : [...refs, ref]
}

/** Drop the ref matching the target's key. Same array reference when nothing matched. */
export function removeRef(
  refs: ContextRef[],
  target: { kind?: string; name?: string; convId?: string; msgId?: string },
): ContextRef[] {
  const key = refKey(target)
  const next = refs.filter((r) => refKey(r) !== key)
  return next.length === refs.length ? refs : next
}

export interface AiSession {
  id: string
  title: string | null
  model: string | null
  createdAt: number
  updatedAt: number
  summary: string | null
  summaryUptoIdx: number
  totalTokens: number
  contextRefs: ContextRef[]
}

/** The minimal UIMessage shape we persist — parts/metadata stay opaque JSON. */
export interface StoredUIMessage {
  id: string
  role: "user" | "assistant" | "system"
  parts: unknown[]
  metadata?: unknown
}

interface SessionRow {
  id: string
  title: string | null
  model: string | null
  created_at: number
  updated_at: number
  summary: string | null
  summary_upto_idx: number
  total_tokens: number
  context_refs: string | null
}

function shapeSession(r: SessionRow): AiSession {
  let refs: ContextRef[] = []
  try {
    const v = JSON.parse(r.context_refs || "[]")
    if (Array.isArray(v)) {
      // A scope ref (folder/label) is keyed by name; everything else needs a convId. Rows written
      // before refs were typed have no `kind` — infer it from msgId.
      refs = v
        .filter((x) => (isScopeRef(x ?? {}) ? !!x.name : !!x?.convId))
        .map((x) =>
          isScopeRef(x)
            ? { ...x, title: x.title || x.name }
            : { ...x, kind: x.kind === "message" || x.msgId ? "message" : "chat" },
        )
    }
  } catch {
    // poisoned refs degrade to none
  }
  return {
    id: r.id,
    title: r.title,
    model: r.model,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    summary: r.summary,
    summaryUptoIdx: r.summary_upto_idx || 0,
    totalTokens: r.total_tokens || 0,
    contextRefs: refs,
  }
}

export function createSession(
  db: Db,
  opts: { title?: string | null; model?: string | null } = {},
  now: number = Date.now(),
): AiSession {
  const id = randomUUID()
  db.prepare(`
    INSERT INTO ai_sessions (id, title, model, created_at, updated_at, summary_upto_idx, total_tokens, context_refs)
    VALUES (?, ?, ?, ?, ?, 0, 0, '[]')
  `).run(id, opts.title ?? null, opts.model ?? null, now, now)
  return getSession(db, id) as AiSession
}

export function getSession(db: Db, id: string): AiSession | null {
  const r = db.prepare("SELECT * FROM ai_sessions WHERE id = ?").get(id) as SessionRow | undefined
  return r ? shapeSession(r) : null
}

/** Sessions newest-updated first. */
export function listSessions(db: Db): AiSession[] {
  const rows = db
    .prepare("SELECT * FROM ai_sessions ORDER BY updated_at DESC")
    .all() as SessionRow[]
  return rows.map(shapeSession)
}

export function updateSession(
  db: Db,
  id: string,
  patch: {
    title?: string | null
    model?: string | null
    summary?: string | null
    summaryUptoIdx?: number
    addTokens?: number
    contextRefs?: ContextRef[]
  },
  now: number = Date.now(),
): AiSession | null {
  const cur = getSession(db, id)
  if (!cur) return null
  db.prepare(`
    UPDATE ai_sessions SET
      title = @title, model = @model, summary = @summary, summary_upto_idx = @summaryUptoIdx,
      total_tokens = @totalTokens, context_refs = @contextRefs, updated_at = @now
    WHERE id = @id
  `).run({
    id,
    title: patch.title !== undefined ? patch.title : cur.title,
    model: patch.model !== undefined ? patch.model : cur.model,
    summary: patch.summary !== undefined ? patch.summary : cur.summary,
    summaryUptoIdx: patch.summaryUptoIdx !== undefined ? patch.summaryUptoIdx : cur.summaryUptoIdx,
    totalTokens: cur.totalTokens + (patch.addTokens || 0),
    contextRefs: JSON.stringify(
      patch.contextRefs !== undefined ? patch.contextRefs : cur.contextRefs,
    ),
    now,
  })
  return getSession(db, id)
}

export function deleteSession(db: Db, id: string): void {
  db.prepare("DELETE FROM ai_messages WHERE session_id = ?").run(id)
  db.prepare("DELETE FROM ai_sessions WHERE id = ?").run(id)
}

/** Append one UIMessage (next idx). Replaces an existing row with the same message id (a
 *  regenerated assistant message keeps its idx). */
export function appendMessage(
  db: Db,
  sessionId: string,
  msg: StoredUIMessage,
  now: number = Date.now(),
): void {
  const existing = db
    .prepare("SELECT idx FROM ai_messages WHERE session_id = ? AND id = ?")
    .get(sessionId, msg.id) as { idx: number } | undefined
  const idx =
    existing?.idx ??
    ((
      db
        .prepare("SELECT COALESCE(MAX(idx), -1) + 1 AS n FROM ai_messages WHERE session_id = ?")
        .get(sessionId) as {
        n: number
      }
    ).n as number)
  db.prepare(`
    INSERT INTO ai_messages (id, session_id, idx, role, parts, metadata, sdk_major, created_at)
    VALUES (@id, @sessionId, @idx, @role, @parts, @metadata, @sdkMajor, @now)
    ON CONFLICT(session_id, idx) DO UPDATE SET
      id = excluded.id, role = excluded.role, parts = excluded.parts, metadata = excluded.metadata,
      sdk_major = excluded.sdk_major
  `).run({
    id: msg.id,
    sessionId,
    idx,
    role: msg.role,
    parts: JSON.stringify(msg.parts ?? []),
    metadata: msg.metadata === undefined ? null : JSON.stringify(msg.metadata),
    sdkMajor: SDK_MAJOR,
    now,
  })
  db.prepare("UPDATE ai_sessions SET updated_at = ? WHERE id = ?").run(now, sessionId)
}

/** Load a session's UIMessages in idx order. Tolerant: a row whose parts JSON won't parse (or
 *  isn't an array) is dropped — never a crash. */
export function loadMessages(db: Db, sessionId: string): StoredUIMessage[] {
  const rows = db
    .prepare("SELECT id, role, parts, metadata FROM ai_messages WHERE session_id = ? ORDER BY idx")
    .all(sessionId) as { id: string; role: string; parts: string | null; metadata: string | null }[]
  const out: StoredUIMessage[] = []
  for (const r of rows) {
    let parts: unknown
    try {
      parts = JSON.parse(r.parts || "[]")
    } catch {
      continue
    }
    if (!Array.isArray(parts)) continue
    if (r.role !== "user" && r.role !== "assistant" && r.role !== "system") continue
    let metadata: unknown
    try {
      metadata = r.metadata ? JSON.parse(r.metadata) : undefined
    } catch {
      metadata = undefined
    }
    out.push({ id: r.id, role: r.role, parts, metadata })
  }
  return out
}

export function countMessages(db: Db, sessionId: string): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM ai_messages WHERE session_id = ?").get(sessionId) as {
      n: number
    }
  ).n
}

/** The part types `convertToModelMessages` understands — anything else (a future major's parts,
 *  junk) is filtered from what's SENT, while the stored row keeps it verbatim. */
const MODEL_SAFE_PART_TYPES = new Set([
  "text",
  "reasoning",
  "file",
  "step-start",
  "source-url",
  "source-document",
])

export function sanitizePartsForModel(parts: unknown[]): unknown[] {
  return parts.filter((p) => {
    const t = (p as { type?: string })?.type
    if (typeof t !== "string") return false
    return MODEL_SAFE_PART_TYPES.has(t) || t.startsWith("tool-") || t === "dynamic-tool"
  })
}
