// Service-agnostic BFF chat store (PSN-93, Workstream A, decision 10). A durable, query-friendly
// message platform — not just a UI cache — so future background consumers (automation, digests,
// search, agents) read the DB directly. Mirrors core/teams-store.js discipline: DI `better-sqlite3`
// handle (no `require` here → testable against `:memory:`), idempotent `migrate`, version-gated
// upserts, mark-unread sentinel, prefs shape guards.
//
// Every table is keyed/prefixed by `service` so a second provider is purely additive. `messages`
// keeps a `raw` TEXT column holding the provider payload (decision 10) alongside the rendered body,
// so a consumer isn't limited to what the chat UI renders today.

import type BetterSqlite3 from "better-sqlite3"

type Db = BetterSqlite3.Database

import { migrateAssistant } from "./assistant/session-store.ts"
import type { ChatConversation, ChatPrefs } from "./contract.ts"
import { backfillSearchIndex, migrateSearch, syncMessageFts } from "./search.ts"

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS conversations (
    service              TEXT NOT NULL,
    id                   TEXT NOT NULL,
    kind                 TEXT,
    topic                TEXT,
    title                TEXT,
    last_message_id      TEXT,
    last_message_version INTEGER,
    last_message_ts      INTEGER,
    last_message_preview TEXT,
    last_message_from_me INTEGER DEFAULT 0,
    newest_synced_ts     INTEGER,
    oldest_synced_ts     INTEGER,
    muted                INTEGER DEFAULT 0,
    updated_at           INTEGER,
    PRIMARY KEY (service, id)
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    service     TEXT NOT NULL,
    conv_id     TEXT NOT NULL,
    id          TEXT NOT NULL,
    version     INTEGER,
    sender_id   TEXT,
    sender_name TEXT,
    ts          INTEGER,
    body        TEXT,
    raw         TEXT,
    deleted     INTEGER DEFAULT 0,
    edited      INTEGER DEFAULT 0,
    mentions_me INTEGER DEFAULT 0,
    PRIMARY KEY (service, conv_id, id)
  )`,
  `CREATE TABLE IF NOT EXISTS read_state (
    service            TEXT NOT NULL,
    conv_id            TEXT NOT NULL,
    read_horizon_ts    INTEGER,
    local_read_ts      INTEGER,
    unread_bookmark_ts INTEGER,
    PRIMARY KEY (service, conv_id)
  )`,
  `CREATE TABLE IF NOT EXISTS users (
    service      TEXT NOT NULL,
    id           TEXT NOT NULL,
    display_name TEXT,
    updated_at   INTEGER,
    PRIMARY KEY (service, id)
  )`,
  `CREATE TABLE IF NOT EXISTS conversation_prefs (
    service           TEXT NOT NULL,
    conv_id           TEXT NOT NULL,
    labels            TEXT,
    folder            TEXT,
    muted             INTEGER DEFAULT 0,
    muted_until       INTEGER,
    notify_on_mention INTEGER DEFAULT 0,
    custom_title      TEXT,
    PRIMARY KEY (service, conv_id)
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    service TEXT NOT NULL,
    key     TEXT NOT NULL,
    value   TEXT,
    PRIMARY KEY (service, key)
  )`,
  `CREATE TABLE IF NOT EXISTS push_subs (
    service     TEXT NOT NULL,
    endpoint    TEXT NOT NULL,
    device_id   TEXT,
    subscription TEXT,
    updated_at  INTEGER,
    PRIMARY KEY (service, endpoint)
  )`,
]

/** Columns added to a table that already shipped. `ADD COLUMN` has no `IF NOT EXISTS`, so each is
 *  tried and a duplicate-column error swallowed — that is the "already migrated" case. */
const ADDED_COLUMNS: [table: string, column: string, decl: string][] = [
  ["conversations", "title", "TEXT"],
  ["read_state", "unread_bookmark_ts", "INTEGER"],
]

/** Idempotent — safe on every boot (`CREATE … IF NOT EXISTS` + the column adds above). */
export function migrate(db: Db): Db {
  for (const stmt of SCHEMA) db.exec(stmt)
  for (const [table, column, decl] of ADDED_COLUMNS) {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`)
    } catch {
      // already present
    }
  }
  migrateSearch(db)
  backfillSearchIndex(db)
  migrateAssistant(db)
  return db
}

// ---- conversations --------------------------------------------------------

// Teams reserves the `48:` namespace for non-chat threads; only `48:notes` (the self chat) is real.
// Service-agnostic: the guard only applies to Teams-style ids, harmless for other services.
function isReservedConversation(id: string): boolean {
  return typeof id === "string" && id.startsWith("48:") && id !== "48:notes"
}

const PREVIEW_CAP = 500

/** A raw provider conversation → the DB row. The provider (Workstream B) normalizes to this shape;
 *  the store stays provider-agnostic. `read_horizon_ts` (nullable) is ingested into read_state. */
export interface ConversationInput {
  id: string
  kind?: string
  topic?: string | null
  /** Resolved display title (member names for a topic-less DM/group). Best-effort — absent means
   *  unresolved, never "renamed to nothing". Empty/absent never clears a previously stored title. */
  title?: string | null
  lastMessageId?: string | null
  lastMessageVersion?: number
  lastMessageTs?: number | null
  lastMessagePreview?: string
  lastMessageFromMe?: boolean
  readHorizonTs?: number | null
  /** The provider's mark-unread bookmark; 0 clears it. Absent = leave the stored one alone. */
  unreadBookmarkTs?: number | null
}

// Insert new, update only when `lastMessageVersion` rises (WHERE gate), skip reserved. Sync cursors
// seed to the last-message ts ONCE on insert and are never clobbered by an update. Returns the rows
// it processed (non-reserved).
//
// Title is handled separately from the version-gated DO UPDATE: a resolved name may arrive on any
// fetch regardless of message-version changes, and an absent/empty title never clears a stored one
// (absent = unresolved, not renamed-to-nothing).
export function upsertConversations(
  db: Db,
  service: string,
  list: ConversationInput[],
  now: number = Date.now(),
): ConversationInput[] {
  const stmt = db.prepare(`
    INSERT INTO conversations
      (service, id, kind, topic, title, last_message_id, last_message_version, last_message_ts,
       last_message_preview, last_message_from_me, newest_synced_ts, oldest_synced_ts, muted, updated_at)
    VALUES
      (@service, @id, @kind, @topic, @title, @last_message_id, @last_message_version, @last_message_ts,
       @last_message_preview, @last_message_from_me, @last_message_ts, @last_message_ts, 0, @updated_at)
    ON CONFLICT(service, id) DO UPDATE SET
      kind = excluded.kind,
      topic = excluded.topic,
      last_message_id = excluded.last_message_id,
      last_message_version = excluded.last_message_version,
      last_message_ts = excluded.last_message_ts,
      last_message_preview = excluded.last_message_preview,
      last_message_from_me = excluded.last_message_from_me,
      updated_at = excluded.updated_at
    WHERE excluded.last_message_version > conversations.last_message_version
  `)
  // Ungated title update: lands whenever a non-empty title arrives, independent of version.
  // Never clears a stored title — an empty/absent incoming title means "still unresolved".
  const titleStmt = db.prepare(`
    UPDATE conversations SET title = @title
    WHERE service = @service AND id = @id
  `)
  const processed: ConversationInput[] = []
  const run = db.transaction((convs: ConversationInput[]) => {
    for (const conv of convs) {
      if (!conv?.id || isReservedConversation(conv.id)) continue
      const preview = conv.lastMessagePreview ?? ""
      const title = typeof conv.title === "string" ? conv.title.trim() : null
      stmt.run({
        service,
        id: conv.id,
        kind: conv.kind ?? null,
        topic: conv.topic ?? null,
        title: title || null,
        last_message_id: conv.lastMessageId ?? null,
        last_message_version: Number(conv.lastMessageVersion) || 0,
        last_message_ts: conv.lastMessageTs ?? null,
        last_message_preview:
          preview.length > PREVIEW_CAP ? preview.slice(0, PREVIEW_CAP) : preview,
        last_message_from_me: conv.lastMessageFromMe ? 1 : 0,
        updated_at: now,
      })
      // Apply a resolved title regardless of whether the version-gated update ran.
      if (title) titleStmt.run({ service, id: conv.id, title })
      if (conv.readHorizonTs != null) setReadHorizon(db, service, conv.id, conv.readHorizonTs)
      if (conv.unreadBookmarkTs != null)
        setUnreadBookmark(db, service, conv.id, conv.unreadBookmarkTs)
      processed.push(conv)
    }
  })
  run(list || [])
  return processed
}

// The conversation list for a service, newest-first — the /api/chat/conversations read model.
export function listConversations(db: Db, service: string): ChatConversation[] {
  const rows = db
    .prepare(`
      SELECT c.id, c.kind, c.topic, c.title, c.last_message_id, c.last_message_version, c.last_message_ts,
             c.last_message_preview, c.last_message_from_me, c.muted,
             r.read_horizon_ts, r.local_read_ts, r.unread_bookmark_ts
      FROM conversations c
      LEFT JOIN read_state r ON r.service = c.service AND r.conv_id = c.id
      WHERE c.service = ?
      ORDER BY c.last_message_ts DESC NULLS LAST, c.id
    `)
    .all(service) as ReadRow[]
  const mentionCount = db.prepare(`
    SELECT COUNT(*) AS n FROM messages
    WHERE service = ? AND conv_id = ? AND mentions_me = 1 AND deleted = 0 AND ts > ?
  `)
  return rows.map((r) => {
    const sticky = (r.unread_bookmark_ts || 0) > 0
    const readTs = effectiveReadTs(r)
    const n = (mentionCount.get(service, r.id, readTs) as { n: number } | undefined)?.n || 0
    return {
      service,
      id: r.id,
      kind: (r.kind as ChatConversation["kind"]) || "group",
      topic: r.topic,
      // Omit rather than emit null — `title` is optional in ChatConversation; undefined = unresolved.
      ...(r.title ? { title: r.title } : {}),
      lastMessageId: r.last_message_id,
      lastMessageVersion: r.last_message_version,
      lastMessageTs: r.last_message_ts,
      lastMessagePreview: r.last_message_preview,
      lastMessageFromMe: !!r.last_message_from_me,
      readTs,
      unreadSticky: sticky,
      muted: !!r.muted,
      mentionCount: n,
    }
  })
}

interface ReadRow {
  id: string
  kind: string | null
  topic: string | null
  title: string | null
  last_message_id: string | null
  last_message_version: number
  last_message_ts: number | null
  last_message_preview: string
  last_message_from_me: number
  muted: number
  read_horizon_ts: number | null
  local_read_ts: number | null
  unread_bookmark_ts: number | null
}

/** The watermark a row's unread is measured against: `lastMessageTs > readTs` means unread.
 *  A mark-unread bookmark wins — it sits one tick below the message it flagged, so that message
 *  and everything after it read unread even though the read watermark has moved past them. */
export function effectiveReadTs(r: {
  read_horizon_ts: number | null
  local_read_ts: number | null
  unread_bookmark_ts: number | null
}): number {
  const bookmark = r.unread_bookmark_ts || 0
  if (bookmark > 0) return bookmark - 1
  return Math.max(
    r.read_horizon_ts || 0,
    r.local_read_ts && r.local_read_ts > 0 ? r.local_read_ts : 0,
  )
}

// ---- messages -------------------------------------------------------------

/** A rendered message plus its raw provider payload (decision 10). */
export interface MessageInput {
  id: string
  version?: number
  senderId?: string | null
  senderName?: string | null
  ts?: number
  body?: string
  /** The provider payload, kept verbatim for future consumers. Serialized to JSON. */
  raw?: unknown
  deleted?: boolean
  edited?: boolean
  mentionsMe?: boolean
}

// Insert-or-replace by (service, conv_id, id). Advances the conversation's sync cursors to span the
// page (oldest down, newest up) so paging resumes across restarts. Empty is a no-op.
export function upsertMessages(
  db: Db,
  service: string,
  convId: string,
  msgs: MessageInput[],
  now: number = Date.now(),
): void {
  const list = Array.isArray(msgs) ? msgs.filter((m) => m?.id) : []
  if (list.length === 0) return
  const stmt = db.prepare(`
    INSERT INTO messages
      (service, conv_id, id, version, sender_id, sender_name, ts, body, raw, deleted, edited, mentions_me)
    VALUES
      (@service, @conv_id, @id, @version, @sender_id, @sender_name, @ts, @body, @raw, @deleted, @edited, @mentions_me)
    ON CONFLICT(service, conv_id, id) DO UPDATE SET
      version = excluded.version,
      sender_id = excluded.sender_id,
      sender_name = excluded.sender_name,
      ts = excluded.ts,
      body = excluded.body,
      raw = excluded.raw,
      deleted = excluded.deleted,
      edited = excluded.edited,
      mentions_me = excluded.mentions_me
  `)
  const advance = db.prepare(`
    UPDATE conversations SET
      newest_synced_ts = MAX(COALESCE(newest_synced_ts, 0), @newest),
      oldest_synced_ts = MIN(COALESCE(oldest_synced_ts, @oldest), @oldest),
      updated_at = @now
    WHERE service = @service AND id = @convId
  `)
  const rowidStmt = db.prepare(
    "SELECT rowid FROM messages WHERE service = ? AND conv_id = ? AND id = ?",
  )
  const run = db.transaction((rows: MessageInput[]) => {
    let oldest = Number.POSITIVE_INFINITY
    let newest = Number.NEGATIVE_INFINITY
    for (const m of rows) {
      const ts = Number(m.ts) || 0
      stmt.run({
        service,
        conv_id: convId,
        id: String(m.id),
        version: Number.isFinite(m.version) ? m.version : null,
        sender_id: m.senderId || null,
        sender_name: m.senderName || null,
        ts,
        body: m.body || "",
        raw: m.raw === undefined ? null : JSON.stringify(m.raw),
        deleted: m.deleted ? 1 : 0,
        edited: m.edited ? 1 : 0,
        mentions_me: m.mentionsMe ? 1 : 0,
      })
      // Keep the FTS shadow in lockstep — the single write funnel (ADR-0021).
      const row = rowidStmt.get(service, convId, String(m.id)) as { rowid: number } | undefined
      if (row) syncMessageFts(db, row.rowid, m.body || "", !!m.deleted)
      if (ts > 0) {
        if (ts < oldest) oldest = ts
        if (ts > newest) newest = ts
      }
    }
    if (Number.isFinite(oldest) && Number.isFinite(newest)) {
      advance.run({ service, convId, oldest, newest, now })
    }
  })
  run(list)
}

/** A stored message as `listMessages` returns it. `raw` is parsed back from JSON (null when absent). */
export interface StoredMessage {
  id: string
  ts: number | null
  version: number | null
  senderId: string | null
  senderName: string | null
  body: string
  raw: unknown
  edited: boolean
  deleted: boolean
  mentionsMe: boolean
}

// A conversation's stored messages, newest-first. `before` (exclusive ts cursor) pages older;
// `limit` caps the page (default 30).
export function listMessages(
  db: Db,
  service: string,
  convId: string,
  opts: { before?: number; limit?: number } = {},
): StoredMessage[] {
  const limit =
    Number.isFinite(opts.limit) && (opts.limit as number) > 0
      ? Math.floor(opts.limit as number)
      : 30
  const before = Number.isFinite(opts.before) ? (opts.before as number) : null
  const rows = db
    .prepare(`
      SELECT id, version, sender_id, sender_name, ts, body, raw, deleted, edited, mentions_me
      FROM messages
      WHERE service = @service AND conv_id = @convId
        AND (@before IS NULL OR ts < @before)
      ORDER BY ts DESC, id DESC
      LIMIT @limit
    `)
    .all({ service, convId, before, limit }) as MsgRow[]
  return rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    version: r.version,
    senderId: r.sender_id,
    senderName: r.sender_name,
    body: r.body,
    raw: parseRaw(r.raw),
    edited: !!r.edited,
    deleted: !!r.deleted,
    mentionsMe: !!r.mentions_me,
  }))
}

// ---- DB-served jump windows (t175) ----------------------------------------
// A citation deep-link lands on a message far older than the live newest page. The DB already
// holds it, so the window is served locally — provider cursors untouched.

/** A window centered on a target message. Null when the target isn't stored (never synced /
 *  deleted-before-sync) — the caller falls back honestly. Messages oldest→newest. */
export function listMessagesAround(
  db: Db,
  service: string,
  convId: string,
  targetId: string,
  limit = 30,
): { messages: StoredMessage[]; hasOlder: boolean; hasNewer: boolean } | null {
  const target = db
    .prepare("SELECT ts FROM messages WHERE service = ? AND conv_id = ? AND id = ?")
    .get(service, convId, targetId) as { ts: number | null } | undefined
  if (!target) return null
  const half = Math.max(1, Math.floor(limit / 2))
  const olderRows = db
    .prepare(`
      SELECT id, version, sender_id, sender_name, ts, body, raw, deleted, edited, mentions_me
      FROM messages WHERE service = @service AND conv_id = @convId
        AND (ts < @ts OR (ts = @ts AND id <= @id))
      ORDER BY ts DESC, id DESC LIMIT @n
    `)
    .all({ service, convId, ts: target.ts, id: targetId, n: half + 2 }) as MsgRow[]
  const newerRows = db
    .prepare(`
      SELECT id, version, sender_id, sender_name, ts, body, raw, deleted, edited, mentions_me
      FROM messages WHERE service = @service AND conv_id = @convId
        AND (ts > @ts OR (ts = @ts AND id > @id))
      ORDER BY ts ASC, id ASC LIMIT @n
    `)
    .all({ service, convId, ts: target.ts, id: targetId, n: half + 1 }) as MsgRow[]
  const hasOlder = olderRows.length > half + 1
  const hasNewer = newerRows.length > half
  const older = olderRows.slice(0, half + 1).reverse()
  const newer = newerRows.slice(0, half)
  return { messages: [...older, ...newer].map(shapeMessage), hasOlder, hasNewer }
}

/** The next DB page strictly after `afterTs`, oldest→newest — the jump-mode load-newer path that
 *  walks forward until it rejoins the live newest page. */
export function listMessagesAfter(
  db: Db,
  service: string,
  convId: string,
  afterTs: number,
  limit = 30,
): { messages: StoredMessage[]; hasNewer: boolean } {
  const rows = db
    .prepare(`
      SELECT id, version, sender_id, sender_name, ts, body, raw, deleted, edited, mentions_me
      FROM messages WHERE service = @service AND conv_id = @convId AND ts > @afterTs
      ORDER BY ts ASC, id ASC LIMIT @n
    `)
    .all({ service, convId, afterTs, n: limit + 1 }) as MsgRow[]
  return { messages: rows.slice(0, limit).map(shapeMessage), hasNewer: rows.length > limit }
}

/** The DB page strictly before `beforeTs`, oldest→newest — jump-mode's load-older path. */
export function listMessagesBefore(
  db: Db,
  service: string,
  convId: string,
  beforeTs: number,
  limit = 30,
): { messages: StoredMessage[]; hasOlder: boolean } {
  const rows = db
    .prepare(`
      SELECT id, version, sender_id, sender_name, ts, body, raw, deleted, edited, mentions_me
      FROM messages WHERE service = @service AND conv_id = @convId AND ts < @beforeTs
      ORDER BY ts DESC, id DESC LIMIT @n
    `)
    .all({ service, convId, beforeTs, n: limit + 1 }) as MsgRow[]
  return {
    messages: rows.slice(0, limit).reverse().map(shapeMessage),
    hasOlder: rows.length > limit,
  }
}

function shapeMessage(r: MsgRow): StoredMessage {
  return {
    id: r.id,
    ts: r.ts,
    version: r.version,
    senderId: r.sender_id,
    senderName: r.sender_name,
    body: r.body,
    raw: parseRaw(r.raw),
    edited: !!r.edited,
    deleted: !!r.deleted,
    mentionsMe: !!r.mentions_me,
  }
}

/** One stored message by id, or null. Used by the push sweep to read the last message's sender name
 *  and `mentionsMe` (the conversation row alone doesn't carry them). */
export function getMessage(
  db: Db,
  service: string,
  convId: string,
  id: string,
): StoredMessage | null {
  const r = db
    .prepare(`
      SELECT id, version, sender_id, sender_name, ts, body, raw, deleted, edited, mentions_me
      FROM messages WHERE service = ? AND conv_id = ? AND id = ?
    `)
    .get(service, convId, id) as MsgRow | undefined
  if (!r) return null
  return {
    id: r.id,
    ts: r.ts,
    version: r.version,
    senderId: r.sender_id,
    senderName: r.sender_name,
    body: r.body,
    raw: parseRaw(r.raw),
    edited: !!r.edited,
    deleted: !!r.deleted,
    mentionsMe: !!r.mentions_me,
  }
}

interface MsgRow {
  id: string
  version: number | null
  sender_id: string | null
  sender_name: string | null
  ts: number | null
  body: string
  raw: string | null
  deleted: number
  edited: number
  mentions_me: number
}

function parseRaw(raw: string | null): unknown {
  if (raw == null) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

// ---- sweep / backfill helpers ---------------------------------------------
// Prior-state readers the sweep (WS-D) diffs a fresh fetch against, plus the sync cursors + conv id
// list the backfill engine resumes from. Keep them minimal — the sweep planner is pure.

/** The prior conversation view (version + effective readTs + sticky) keyed by id — what the sweep
 *  planner diffs a fresh page against. Reuses `listConversations` so readTs math stays in one place. */
export function priorConversations(
  db: Db,
  service: string,
): Map<string, { lastMessageVersion: number; readTs: number; unreadSticky: boolean }> {
  const map = new Map<
    string,
    { lastMessageVersion: number; readTs: number; unreadSticky: boolean }
  >()
  for (const c of listConversations(db, service)) {
    map.set(c.id, {
      lastMessageVersion: c.lastMessageVersion,
      readTs: c.readTs,
      unreadSticky: c.unreadSticky,
    })
  }
  return map
}

/** Prior stored messages for a conversation keyed by id, carrying only the fields the sweep planner
 *  compares (body/edited/deleted + a reaction signature parsed out of `raw`). Bounded to the newest
 *  `limit` (a sweep only re-fetches the newest page). */
export function priorMessages(
  db: Db,
  service: string,
  convId: string,
  limit = 60,
): Map<string, { body: string; edited: boolean; deleted: boolean; reactionSig: string }> {
  const map = new Map<
    string,
    { body: string; edited: boolean; deleted: boolean; reactionSig: string }
  >()
  for (const m of listMessages(db, service, convId, { limit })) {
    const reactions = (m.raw as { reactions?: { key: string; count: number; mine?: boolean }[] })
      ?.reactions
    const reactionSig =
      Array.isArray(reactions) && reactions.length
        ? reactions
            .map((r) => `${r.key}:${r.count}:${r.mine ? 1 : 0}`)
            .sort()
            .join("|")
        : ""
    map.set(m.id, { body: m.body, edited: m.edited, deleted: m.deleted, reactionSig })
  }
  return map
}

/** Every conversation id for a service, newest-first — the backfill engine's work list. */
export function listConversationIds(db: Db, service: string): string[] {
  const rows = db
    .prepare(
      "SELECT id FROM conversations WHERE service = ? ORDER BY last_message_ts DESC NULLS LAST, id",
    )
    .all(service) as { id: string }[]
  return rows.map((r) => r.id)
}

/** The sync cursors for a conversation — how far paging has reached. `oldestSyncedTs` is the backfill
 *  resume point (paging continues from below it). Null when the conversation has no synced messages. */
export function getSyncCursors(
  db: Db,
  service: string,
  convId: string,
): { newestSyncedTs: number | null; oldestSyncedTs: number | null } | null {
  const r = db
    .prepare(
      "SELECT newest_synced_ts, oldest_synced_ts FROM conversations WHERE service = ? AND id = ?",
    )
    .get(service, convId) as
    | { newest_synced_ts: number | null; oldest_synced_ts: number | null }
    | undefined
  if (!r) return null
  return { newestSyncedTs: r.newest_synced_ts, oldestSyncedTs: r.oldest_synced_ts }
}

/** Persist a per-conversation backfill cursor so a restart resumes mid-run instead of re-paging from
 *  the top. Stored in `settings` keyed `backfill.cursor.<convId>` (opaque provider cursor string).
 *  `null` clears it (conversation finished). */
export function setBackfillCursor(
  db: Db,
  service: string,
  convId: string,
  cursor: string | null,
): void {
  const key = `backfill.cursor.${convId}`
  if (cursor == null) {
    db.prepare("DELETE FROM settings WHERE service = ? AND key = ?").run(service, key)
    return
  }
  db.prepare(
    "INSERT INTO settings (service, key, value) VALUES (?, ?, ?) ON CONFLICT(service, key) DO UPDATE SET value = excluded.value",
  ).run(service, key, cursor)
}

export function getBackfillCursor(db: Db, service: string, convId: string): string | null {
  const r = db
    .prepare("SELECT value FROM settings WHERE service = ? AND key = ?")
    .get(service, `backfill.cursor.${convId}`) as { value: string } | undefined
  return r?.value ?? null
}

// ---- users (display-name cache) -------------------------------------------

export function upsertUsers(
  db: Db,
  service: string,
  list: { id: string; displayName: string }[],
  now: number = Date.now(),
): void {
  const rows = (Array.isArray(list) ? list : []).filter((u) => u?.id && u?.displayName)
  if (rows.length === 0) return
  const stmt = db.prepare(`
    INSERT INTO users (service, id, display_name, updated_at)
    VALUES (@service, @id, @display_name, @updated_at)
    ON CONFLICT(service, id) DO UPDATE SET
      display_name = excluded.display_name,
      updated_at = excluded.updated_at
  `)
  const run = db.transaction((us: { id: string; displayName: string }[]) => {
    for (const u of us)
      stmt.run({ service, id: u.id, display_name: u.displayName, updated_at: now })
  })
  run(rows)
}

/** Cached names for a set of ids → Map(id → displayName). Only hits present (caller diffs for
 *  misses). Empty list → empty map. */
export function getUsers(db: Db, service: string, ids: string[]): Map<string, string> {
  const map = new Map<string, string>()
  const clean = Array.isArray(ids) ? ids.filter(Boolean) : []
  if (clean.length === 0) return map
  const placeholders = clean.map(() => "?").join(",")
  const rows = db
    .prepare(`SELECT id, display_name FROM users WHERE service = ? AND id IN (${placeholders})`)
    .all(service, ...clean) as { id: string; display_name: string }[]
  for (const r of rows) map.set(r.id, r.display_name)
  return map
}

// ---- read state -----------------------------------------------------------
// Read state is shared with the provider (PSN-102): every local read/unread is written through to
// the service, and the sweep ingests the service's own state back. Three columns:
//   `read_horizon_ts`    the service's read watermark (monotonic — it never rewinds)
//   `local_read_ts`      the same watermark applied optimistically, before the sweep confirms it
//   `unread_bookmark_ts` an explicit mark-unread at that ts; 0/absent = not marked unread
// The bookmark exists because a read watermark can only move forward, so it can never express
// "unread again". When set, it wins over both watermarks — see `effectiveReadTs`.

export function setReadHorizon(db: Db, service: string, convId: string, ts: number): void {
  db.prepare(`
    INSERT INTO read_state (service, conv_id, read_horizon_ts)
    VALUES (@service, @convId, @ts)
    ON CONFLICT(service, conv_id) DO UPDATE SET
      read_horizon_ts = MAX(COALESCE(read_state.read_horizon_ts, 0), excluded.read_horizon_ts)
  `).run({ service, convId, ts: Number(ts) || 0 })
}

// Ingest the service's mark-unread bookmark. NOT monotonic — 0 is how a read elsewhere clears it.
export function setUnreadBookmark(db: Db, service: string, convId: string, ts: number): void {
  db.prepare(`
    INSERT INTO read_state (service, conv_id, unread_bookmark_ts)
    VALUES (@service, @convId, @ts)
    ON CONFLICT(service, conv_id) DO UPDATE SET unread_bookmark_ts = excluded.unread_bookmark_ts
  `).run({ service, convId, ts: Math.max(0, Number(ts) || 0) })
}

// Explicit mark-read: force local_read_ts to `ts` and drop any mark-unread bookmark. NOT monotonic
// — clearing the bookmark is the whole point, and the caller pairs this with the provider write.
export function markConversationRead(db: Db, service: string, convId: string, ts: number): void {
  db.prepare(`
    INSERT INTO read_state (service, conv_id, local_read_ts, unread_bookmark_ts)
    VALUES (@service, @convId, @ts, 0)
    ON CONFLICT(service, conv_id) DO UPDATE SET
      local_read_ts = excluded.local_read_ts,
      unread_bookmark_ts = 0
  `).run({ service, convId, ts: Number(ts) || 0 })
}

// Explicit mark-unread: set the bookmark at `ts`, mirroring what the provider was just told. The
// row reads unread past the (still-advancing) read watermark until a read clears the bookmark.
export function markConversationUnread(db: Db, service: string, convId: string, ts: number): void {
  setUnreadBookmark(db, service, convId, Math.max(1, Number(ts) || 1))
}

export function getReadState(
  db: Db,
  service: string,
  convId: string,
): { readHorizonTs: number | null; localReadTs: number | null; readTs: number } | null {
  const r = db
    .prepare(
      "SELECT read_horizon_ts, local_read_ts, unread_bookmark_ts FROM read_state WHERE service = ? AND conv_id = ?",
    )
    .get(service, convId) as ReadStateRow | undefined
  if (!r) return null
  return {
    readHorizonTs: r.read_horizon_ts,
    localReadTs: r.local_read_ts,
    readTs: effectiveReadTs(r),
  }
}

interface ReadStateRow {
  read_horizon_ts: number | null
  local_read_ts: number | null
  unread_bookmark_ts: number | null
}

// ---- conversation prefs ---------------------------------------------------
// LOCAL labels / folder / mute per conversation — never written to the provider. Shared across
// devices (server-side, not device-keyed). `labels` persists as a JSON string array.

function emptyPrefs(): ChatPrefs {
  return {
    labels: [],
    folder: null,
    muted: false,
    mutedUntil: null,
    notifyOnMention: false,
    customTitle: null,
  }
}

interface PrefRow {
  labels: string | null
  folder: string | null
  muted: number
  muted_until: number | null
  notify_on_mention: number
  custom_title: string | null
}

function shapePrefs(r: PrefRow): ChatPrefs {
  return {
    labels: parseLabels(r.labels),
    folder: r.folder || null,
    muted: !!r.muted,
    mutedUntil: r.muted_until ?? null,
    notifyOnMention: !!r.notify_on_mention,
    customTitle: r.custom_title || null,
  }
}

export function getPrefs(db: Db, service: string, convId: string): ChatPrefs {
  const r = db
    .prepare(
      "SELECT labels, folder, muted, muted_until, notify_on_mention, custom_title FROM conversation_prefs WHERE service = ? AND conv_id = ?",
    )
    .get(service, convId) as PrefRow | undefined
  return r ? shapePrefs(r) : emptyPrefs()
}

export function getAllPrefs(db: Db, service: string): Record<string, ChatPrefs> {
  const map: Record<string, ChatPrefs> = {}
  const rows = db
    .prepare(
      "SELECT conv_id, labels, folder, muted, muted_until, notify_on_mention, custom_title FROM conversation_prefs WHERE service = ?",
    )
    .all(service) as (PrefRow & { conv_id: string })[]
  for (const r of rows) map[r.conv_id] = shapePrefs(r)
  return map
}

export interface PrefsPatch {
  labels?: string[]
  folder?: string | null
  muted?: boolean
  mutedUntil?: number | null
  notifyOnMention?: boolean
  customTitle?: string | null
}

// Patch a conversation's prefs (upsert). Only provided keys change (COALESCE against the row).
// Setting `muted` without `mutedUntil` clears any stale expiry ("mute forever" can't inherit one).
export function setPrefs(db: Db, service: string, convId: string, patch: PrefsPatch): ChatPrefs {
  const cur = getPrefs(db, service, convId)
  const labels = patch.labels !== undefined ? sanitizeLabels(patch.labels) : cur.labels
  const folder =
    patch.folder !== undefined
      ? patch.folder
        ? String(patch.folder).trim() || null
        : null
      : cur.folder
  const muted = patch.muted !== undefined ? (patch.muted ? 1 : 0) : cur.muted ? 1 : 0
  const mutedUntil =
    patch.muted !== undefined
      ? Number.isFinite(patch.mutedUntil)
        ? (patch.mutedUntil as number)
        : null
      : patch.mutedUntil !== undefined
        ? Number.isFinite(patch.mutedUntil)
          ? (patch.mutedUntil as number)
          : null
        : (cur.mutedUntil ?? null)
  const notifyOnMention =
    patch.notifyOnMention !== undefined
      ? patch.notifyOnMention
        ? 1
        : 0
      : cur.notifyOnMention
        ? 1
        : 0
  const customTitle =
    patch.customTitle !== undefined
      ? patch.customTitle
        ? String(patch.customTitle).trim() || null
        : null
      : (cur.customTitle ?? null)
  db.prepare(`
    INSERT INTO conversation_prefs (service, conv_id, labels, folder, muted, muted_until, notify_on_mention, custom_title)
    VALUES (@service, @convId, @labels, @folder, @muted, @mutedUntil, @notifyOnMention, @customTitle)
    ON CONFLICT(service, conv_id) DO UPDATE SET labels = excluded.labels, folder = excluded.folder,
      muted = excluded.muted, muted_until = excluded.muted_until,
      notify_on_mention = excluded.notify_on_mention, custom_title = excluded.custom_title
  `).run({
    service,
    convId,
    labels: JSON.stringify(labels),
    folder,
    muted,
    mutedUntil,
    notifyOnMention,
    customTitle,
  })
  return {
    labels,
    folder,
    muted: !!muted,
    mutedUntil,
    notifyOnMention: !!notifyOnMention,
    customTitle,
  }
}

function parseLabels(raw: string | null): string[] {
  if (typeof raw !== "string" || !raw) return []
  try {
    return sanitizeLabels(JSON.parse(raw))
  } catch {
    return []
  }
}

// Trim, drop empties, dedupe, cap length.
function sanitizeLabels(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const s of v) {
    const t = String(s || "")
      .trim()
      .slice(0, 40)
    if (t && !out.includes(t)) out.push(t)
  }
  return out
}

// ---- folder order (settings) ----------------------------------------------

export function getFolderOrder(db: Db, service: string): string[] {
  const r = db
    .prepare("SELECT value FROM settings WHERE service = ? AND key = 'folderOrder'")
    .get(service) as { value: string } | undefined
  if (!r) return []
  try {
    const v = JSON.parse(r.value)
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

export function setFolderOrder(db: Db, service: string, order: string[]): string[] {
  if (!Array.isArray(order)) return []
  const clean = order.filter((s) => typeof s === "string" && s.trim())
  db.prepare(
    "INSERT INTO settings (service, key, value) VALUES (?, 'folderOrder', ?) ON CONFLICT(service, key) DO UPDATE SET value = excluded.value",
  ).run(service, JSON.stringify(clean))
  return clean
}

// ---- push subscriptions ---------------------------------------------------
// Per-service web-push subs (decision 8: the BFF owns Teams push). Keyed by endpoint. `subscription`
// is the full PushSubscription JSON.

export interface PushSubInput {
  endpoint: string
  deviceId?: string | null
  subscription: unknown
}

export function savePushSub(
  db: Db,
  service: string,
  sub: PushSubInput,
  now: number = Date.now(),
): void {
  if (!sub?.endpoint) return
  db.prepare(`
    INSERT INTO push_subs (service, endpoint, device_id, subscription, updated_at)
    VALUES (@service, @endpoint, @deviceId, @subscription, @updatedAt)
    ON CONFLICT(service, endpoint) DO UPDATE SET
      device_id = excluded.device_id,
      subscription = excluded.subscription,
      updated_at = excluded.updated_at
  `).run({
    service,
    endpoint: sub.endpoint,
    deviceId: sub.deviceId ?? null,
    subscription: JSON.stringify(sub.subscription ?? null),
    updatedAt: now,
  })
}

export interface StoredPushSub {
  endpoint: string
  deviceId: string | null
  subscription: unknown
}

export function listPushSubs(db: Db, service: string): StoredPushSub[] {
  const rows = db
    .prepare("SELECT endpoint, device_id, subscription FROM push_subs WHERE service = ?")
    .all(service) as { endpoint: string; device_id: string | null; subscription: string | null }[]
  return rows.map((r) => ({
    endpoint: r.endpoint,
    deviceId: r.device_id,
    subscription: parseRaw(r.subscription),
  }))
}

export function deletePushSub(db: Db, service: string, endpoint: string): void {
  db.prepare("DELETE FROM push_subs WHERE service = ? AND endpoint = ?").run(service, endpoint)
}
