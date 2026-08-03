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
import type { ChatConversation, ChatPrefs, ReplySuggestionBatch } from "./contract.ts"
import {
  MAX_VERSIONS_PER_MESSAGE,
  type PrevBody,
  planSnapshot,
  resolveBody,
} from "./edit-history.ts"
import { extractImages } from "./media-images.ts"
import { captionsForMessage, migrateMedia, recordMessageImages } from "./media-store.ts"
import { backfillSearchIndex, migrateSearch, syncMessageFts } from "./search.ts"

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS conversations (
    service              TEXT NOT NULL,
    id                   TEXT NOT NULL,
    kind                 TEXT,
    topic                TEXT,
    title                TEXT,
    avatar_user_id       TEXT,
    member_ids           TEXT,
    last_message_id      TEXT,
    last_message_version INTEGER,
    last_message_ts      INTEGER,
    last_message_preview TEXT,
    last_message_from_me INTEGER DEFAULT 0,
    last_message_sender_name TEXT,
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
  // Superseded message bodies (PSN-105 C). Teams keeps no previous version, so this is the ONLY
  // copy — appended in `upsertMessages` the moment before the row's body is overwritten. Not keyed
  // by a primary key: a message has many versions, ordered by rowid (append order).
  `CREATE TABLE IF NOT EXISTS message_edits (
    service     TEXT NOT NULL,
    conv_id     TEXT NOT NULL,
    msg_id      TEXT NOT NULL,
    body        TEXT,
    edit_ts     INTEGER,
    captured_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS message_edits_msg
     ON message_edits (service, conv_id, msg_id)`,
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
  // Backfill run history (PSN-105 N). The engine's status is in-memory and dies with the process,
  // so "did last night's deep fetch finish, and what did it cost?" was unanswerable after a
  // restart. One row per run, inserted when it starts and completed when it ends — a row left
  // unfinished by a crash keeps its `aborted` default, which is the honest reading.
  `CREATE TABLE IF NOT EXISTS backfill_runs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    service       TEXT NOT NULL,
    started_at    INTEGER,
    finished_at   INTEGER,
    days          INTEGER,
    conversations INTEGER DEFAULT 0,
    messages      INTEGER DEFAULT 0,
    status        TEXT DEFAULT 'aborted',
    error         TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS backfill_runs_service ON backfill_runs (service, id)`,
  `CREATE TABLE IF NOT EXISTS push_subs (
    service     TEXT NOT NULL,
    endpoint    TEXT NOT NULL,
    device_id   TEXT,
    subscription TEXT,
    updated_at  INTEGER,
    PRIMARY KEY (service, endpoint)
  )`,
  // Candidate replies an agent wrote for a conversation (ADR-0027). One row per BATCH, not per
  // suggestion: the texts are alternatives to each other, so `chosen_idx` is only meaningful while
  // they sit together. `producer` is the whole provider abstraction — a second source is a WHERE
  // clause, not a migration. `sent_text` is what actually went out after the user edited the
  // suggestion in the composer; the diff against `texts[chosen_idx]` is the point of the table.
  `CREATE TABLE IF NOT EXISTS reply_suggestions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    service     TEXT NOT NULL,
    conv_id     TEXT NOT NULL,
    for_msg_id  TEXT,
    producer    TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    status      TEXT NOT NULL DEFAULT 'open',
    texts       TEXT NOT NULL,
    chosen_idx  INTEGER,
    chosen_at   INTEGER,
    sent_msg_id TEXT,
    sent_text   TEXT,
    sent_at     INTEGER
  )`,
  // The hot read is "the live batch for this conversation" — status-first so the partial scan stops
  // at the handful of open/chosen rows instead of walking a conversation's whole history.
  `CREATE INDEX IF NOT EXISTS reply_suggestions_live
     ON reply_suggestions (service, conv_id, status, id)`,
]

/** Columns added to a table that already shipped. `ADD COLUMN` has no `IF NOT EXISTS`, so each is
 *  tried and a duplicate-column error swallowed — that is the "already migrated" case. */
const ADDED_COLUMNS: [table: string, column: string, decl: string][] = [
  ["conversations", "title", "TEXT"],
  ["conversations", "avatar_user_id", "TEXT"],
  ["conversations", "member_ids", "TEXT"],
  ["read_state", "unread_bookmark_ts", "INTEGER"],
  ["messages", "edit_ts", "INTEGER"],
  ["conversations", "last_message_sender_name", "TEXT"],
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
  migrateMedia(db)
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
  /** Resolved identity, same contract as `title`: absent = unresolved, never "has no avatar". The
   *  1:1's other member / the self chat's viewer; absent for a group (its facepile uses memberIds). */
  avatarUserId?: string | null
  /** A group's first few non-self member ids (facepile). Absent/empty = unresolved, never cleared. */
  memberIds?: string[] | null
  lastMessageId?: string | null
  lastMessageVersion?: number
  lastMessageTs?: number | null
  lastMessagePreview?: string
  lastMessageFromMe?: boolean
  /** Resolved display name of the last message's sender (group-chat preview prefix,
   *  PSN-113 C-fix). Absent = unresolved, never clears a stored name (COALESCE). */
  lastMessageSender?: string | null
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
      (service, id, kind, topic, title, avatar_user_id, member_ids, last_message_id,
       last_message_version, last_message_ts,
       last_message_preview, last_message_from_me, newest_synced_ts, oldest_synced_ts, muted, updated_at)
    VALUES
      (@service, @id, @kind, @topic, @title, @avatar_user_id, @member_ids, @last_message_id,
       @last_message_version, @last_message_ts,
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
  // Ungated identity update: title + avatar fields land whenever a resolved value arrives,
  // independent of version (a name/roster resolves on its own schedule). `COALESCE` is the
  // never-clear rule — a null (empty/absent) incoming value means "still unresolved", not "cleared".
  // `last_message_sender_name` follows the same contract (PSN-113 C-fix): the raw conv-list
  // payload carries the sender MRI on every sweep, so the resolved name lands whenever Graph
  // resolves it — an absent value never reverts a previously-resolved name.
  const identityStmt = db.prepare(`
    UPDATE conversations SET
      title = COALESCE(@title, title),
      avatar_user_id = COALESCE(@avatar_user_id, avatar_user_id),
      member_ids = COALESCE(@member_ids, member_ids),
      last_message_sender_name = COALESCE(@last_message_sender_name, last_message_sender_name)
    WHERE service = @service AND id = @id
  `)
  const processed: ConversationInput[] = []
  const run = db.transaction((convs: ConversationInput[]) => {
    for (const conv of convs) {
      if (!conv?.id || isReservedConversation(conv.id)) continue
      const preview = conv.lastMessagePreview ?? ""
      const title = typeof conv.title === "string" ? conv.title.trim() : null
      const identity = {
        service,
        id: conv.id,
        title: title || null,
        avatar_user_id: conv.avatarUserId || null,
        member_ids: conv.memberIds?.length ? JSON.stringify(conv.memberIds) : null,
        last_message_sender_name: conv.lastMessageSender || null,
      }
      stmt.run({
        ...identity,
        kind: conv.kind ?? null,
        topic: conv.topic ?? null,
        last_message_id: conv.lastMessageId ?? null,
        last_message_version: Number(conv.lastMessageVersion) || 0,
        last_message_ts: conv.lastMessageTs ?? null,
        last_message_preview:
          preview.length > PREVIEW_CAP ? preview.slice(0, PREVIEW_CAP) : preview,
        last_message_from_me: conv.lastMessageFromMe ? 1 : 0,
        updated_at: now,
      })
      // Apply resolved identity regardless of whether the version-gated update ran.
      identityStmt.run(identity)
      if (conv.readHorizonTs != null) setReadHorizon(db, service, conv.id, conv.readHorizonTs)
      if (conv.unreadBookmarkTs != null)
        setUnreadBookmark(db, service, conv.id, conv.unreadBookmarkTs)
      processed.push(conv)
    }
  })
  run(list || [])
  return processed
}

// Stored as a JSON array; a corrupt/legacy value degrades to "unresolved" rather than throwing.
function parseMemberIds(raw: string | null): string[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x) : []
  } catch {
    return []
  }
}

// The conversation list for a service, newest-first — the /api/chat/conversations read model.
export function listConversations(db: Db, service: string): ChatConversation[] {
  const rows = db
    .prepare(`
      SELECT c.id, c.kind, c.topic, c.title, c.avatar_user_id, c.member_ids,
             c.last_message_id, c.last_message_version, c.last_message_ts,
             c.last_message_preview, c.last_message_from_me, c.last_message_sender_name, c.muted,
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
    const memberIds = parseMemberIds(r.member_ids)
    return {
      service,
      id: r.id,
      kind: (r.kind as ChatConversation["kind"]) || "group",
      topic: r.topic,
      // Omit rather than emit null — `title` is optional in ChatConversation; undefined = unresolved.
      ...(r.title ? { title: r.title } : {}),
      // Same omit-don't-null rule as `title`: absent means unresolved, so a delta can't stomp a
      // resolved avatar back to the initials tile (the WS conversation-upsert ships these rows).
      ...(r.avatar_user_id ? { avatarUserId: r.avatar_user_id } : {}),
      ...(memberIds.length ? { memberIds } : {}),
      lastMessageId: r.last_message_id,
      lastMessageVersion: r.last_message_version,
      lastMessageTs: r.last_message_ts,
      lastMessagePreview: r.last_message_preview,
      lastMessageFromMe: !!r.last_message_from_me,
      // PSN-113 C-fix: resolved at the /internal/teams seam from `lastMessage.from` (raw conv
      // list) via a Graph batch, persisted on the row — no read-time JOIN on `messages` (which
      // is empty for a never-opened thread and was the source of the fresh-DB miss).
      ...(r.last_message_sender_name ? { lastMessageSender: r.last_message_sender_name } : {}),
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
  avatar_user_id: string | null
  member_ids: string | null
  last_message_id: string | null
  last_message_version: number
  last_message_ts: number | null
  last_message_preview: string
  last_message_from_me: number
  muted: number
  read_horizon_ts: number | null
  local_read_ts: number | null
  unread_bookmark_ts: number | null
  last_message_sender_name: string | null
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
  /** When the provider says the last edit landed (epoch ms) — stamps the snapshot it supersedes. */
  editTs?: number
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
      (service, conv_id, id, version, sender_id, sender_name, ts, body, raw, deleted, edited, edit_ts, mentions_me)
    VALUES
      (@service, @conv_id, @id, @version, @sender_id, @sender_name, @ts, @body, @raw, @deleted, @edited, @edit_ts, @mentions_me)
    ON CONFLICT(service, conv_id, id) DO UPDATE SET
      version = excluded.version,
      sender_id = excluded.sender_id,
      sender_name = excluded.sender_name,
      ts = excluded.ts,
      body = excluded.body,
      raw = excluded.raw,
      deleted = excluded.deleted,
      edited = excluded.edited,
      edit_ts = excluded.edit_ts,
      mentions_me = excluded.mentions_me
  `)
  // Edit history (PSN-105 C): the bodies about to be overwritten. Read in ONE batched statement —
  // this runs on the 4s/12s sweep path, so a per-message SELECT would be a round-trip tax.
  const prevBodies = readBodies(
    db,
    service,
    convId,
    list.map((m) => String(m.id)),
  )
  const snapStmt = db.prepare(`
    INSERT INTO message_edits (service, conv_id, msg_id, body, edit_ts, captured_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  // Keep the newest MAX_VERSIONS_PER_MESSAGE (R3) — append order is rowid order — PLUS one. The
  // spare row is what makes "older versions were dropped" a fact instead of a guess: the reader
  // returns the cap and reports truncation only when that extra row exists (PSN-105 QE DEF-5;
  // `length >= cap` called exactly-20 truncated when nothing had been dropped).
  const trimStmt = db.prepare(`
    DELETE FROM message_edits
    WHERE service = ? AND conv_id = ? AND msg_id = ? AND rowid NOT IN (
      SELECT rowid FROM message_edits
      WHERE service = ? AND conv_id = ? AND msg_id = ?
      ORDER BY rowid DESC LIMIT ${MAX_VERSIONS_PER_MESSAGE + 1}
    )
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
      const msgId = String(m.id)
      const prev = prevBodies.get(msgId)
      const snapshot = planSnapshot(prev, m, now)
      if (snapshot) {
        snapStmt.run(service, convId, msgId, snapshot.body, snapshot.editTs, now)
        trimStmt.run(service, convId, msgId, service, convId, msgId)
      }
      // The ONE place the persisted body is decided (DEF-1). Everything downstream — `raw`, the
      // media extraction, the FTS shadow — reads this value, so a rejected blank payload can't leak
      // back in through a side channel.
      const body = resolveBody(prev, m)
      const raw = rawWithBody(m.raw, m.body ?? "", body)
      stmt.run({
        service,
        conv_id: convId,
        id: String(m.id),
        version: Number.isFinite(m.version) ? m.version : null,
        sender_id: m.senderId || null,
        sender_name: m.senderName || null,
        ts,
        body,
        raw: raw === undefined ? null : JSON.stringify(raw),
        deleted: m.deleted ? 1 : 0,
        edited: m.edited ? 1 : 0,
        edit_ts: Number.isFinite(m.editTs) ? m.editTs : null,
        mentions_me: m.mentionsMe ? 1 : 0,
      })
      // Inline images are registered here (PSN-104) so the caption worker — which drains
      // `message_media` rows, needing no hook back into this write path — has something to pick up,
      // and so an already-transcribed image is searchable the moment its message lands.
      const images = m.deleted ? [] : extractImages(body)
      if (images.length) recordMessageImages(db, service, convId, String(m.id), images, now)
      // Keep the FTS shadow in lockstep — the single write funnel (ADR-0021).
      const row = rowidStmt.get(service, convId, String(m.id)) as { rowid: number } | undefined
      if (row) {
        const captions = images.length ? captionsForMessage(db, service, convId, String(m.id)) : []
        syncMessageFts(db, row.rowid, body, !!m.deleted, captions)
      }
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

/** Keep `raw` in step when the write path rejected the incoming body (DEF-1). `raw` is replayed
 *  verbatim by the history routes, so leaving the blank in there would render the loss anyway. */
function rawWithBody(raw: unknown, incoming: string, persisted: string): unknown {
  if (raw === undefined || persisted === incoming) return raw
  if (!raw || typeof raw !== "object") return raw
  return { ...(raw as Record<string, unknown>), body: persisted }
}

/** The stored bodies for a page of ids, in ONE statement (the upsert path is the hot sweep lane).
 *  SQLite's parameter ceiling is ~32k and a page is ~30 rows, so a single `IN (…)` is safe. */
function readBodies(db: Db, service: string, convId: string, ids: string[]): Map<string, PrevBody> {
  const out = new Map<string, PrevBody>()
  if (ids.length === 0) return out
  const rows = db
    .prepare(
      `SELECT id, body, deleted FROM messages
       WHERE service = ? AND conv_id = ? AND id IN (${ids.map(() => "?").join(",")})`,
    )
    .all(service, convId, ...ids) as { id: string; body: string; deleted: number }[]
  for (const r of rows) out.set(r.id, { body: r.body || "", deleted: !!r.deleted })
  return out
}

/** One superseded body as `listMessageEdits` returns it. */
export interface MessageEdit {
  body: string
  editTs: number | null
  capturedAt: number | null
}

/** A message's superseded bodies, NEWEST first (PSN-105 C), capped at MAX_VERSIONS_PER_MESSAGE.
 *  `truncated` is observed, not inferred: the write path keeps one row beyond the cap, so its
 *  presence PROVES an older version was dropped (a full-but-not-over list is not truncation). */
export function listMessageEdits(
  db: Db,
  service: string,
  convId: string,
  msgId: string,
): { versions: MessageEdit[]; truncated: boolean } {
  const rows = db
    .prepare(
      `SELECT body, edit_ts, captured_at FROM message_edits
       WHERE service = ? AND conv_id = ? AND msg_id = ? ORDER BY rowid DESC`,
    )
    .all(service, convId, msgId) as { body: string; edit_ts: number; captured_at: number }[]
  return {
    versions: rows.slice(0, MAX_VERSIONS_PER_MESSAGE).map((r) => ({
      body: r.body || "",
      editTs: r.edit_ts ?? null,
      capturedAt: r.captured_at ?? null,
    })),
    truncated: rows.length > MAX_VERSIONS_PER_MESSAGE,
  }
}

/** Register one stored message's inline images (PSN-104) — the lazy path for a message that landed
 *  before image extraction existed. Idempotent; a message with no images is a no-op. */
export function recordImages(db: Db, service: string, convId: string, msgId: string): void {
  const row = db
    .prepare("SELECT body, deleted FROM messages WHERE service = ? AND conv_id = ? AND id = ?")
    .get(service, convId, msgId) as { body: string; deleted: number } | undefined
  if (!row || row.deleted) return
  const images = extractImages(row.body || "")
  if (images.length) recordMessageImages(db, service, convId, msgId, images)
}

/** Re-index one message from what is stored now (PSN-104) — used when an image transcription lands
 *  after the message did, so the screenshot's text becomes searchable without a re-sweep. */
export function reindexMessage(db: Db, service: string, convId: string, msgId: string): void {
  const row = db
    .prepare(
      "SELECT rowid, body, deleted FROM messages WHERE service = ? AND conv_id = ? AND id = ?",
    )
    .get(service, convId, msgId) as { rowid: number; body: string; deleted: number } | undefined
  if (!row) return
  syncMessageFts(
    db,
    row.rowid,
    row.body || "",
    !!row.deleted,
    captionsForMessage(db, service, convId, msgId),
  )
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

/** Existence check — `true` iff a row exists for this (service, convId, msgId). Cheaper than
 *  `getMessage` for the hydrate pipeline's idempotent fast path, which fires per substrate hit and
 *  doesn't need the row's contents. (PSN-115 WS-B.) */
export function hasMessage(db: Db, service: string, convId: string, id: string): boolean {
  const r = db
    .prepare("SELECT 1 FROM messages WHERE service = ? AND conv_id = ? AND id = ? LIMIT 1")
    .get(service, convId, id) as { 1?: number } | undefined
  return r !== undefined
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

// ---- backfill run history (PSN-105 N) --------------------------------------

/** Runs kept per service. A deep fetch is a manual, rare action — 20 is months of history and
 *  keeps the table a diagnostics log rather than a growing dataset. */
export const MAX_BACKFILL_RUNS = 20

/** Open a run row and return its id. Status starts at `aborted`: a process that dies mid-run never
 *  gets to write an outcome, and "aborted" is exactly what happened. */
export function startBackfillRun(db: Db, service: string, days: number, now = Date.now()): number {
  const info = db
    .prepare(
      `INSERT INTO backfill_runs (service, started_at, days, status) VALUES (?, ?, ?, 'aborted')`,
    )
    .run(service, now, days)
  db.prepare(
    `DELETE FROM backfill_runs WHERE service = ? AND id NOT IN (
       SELECT id FROM backfill_runs WHERE service = ? ORDER BY id DESC LIMIT ${MAX_BACKFILL_RUNS}
     )`,
  ).run(service, service)
  return Number(info.lastInsertRowid)
}

/** Close a run with its outcome + totals. */
export function finishBackfillRun(
  db: Db,
  id: number,
  outcome: {
    conversations: number
    messages: number
    status: "ok" | "error" | "aborted"
    error?: string
  },
  now = Date.now(),
): void {
  db.prepare(
    `UPDATE backfill_runs SET finished_at = ?, conversations = ?, messages = ?, status = ?, error = ?
     WHERE id = ?`,
  ).run(now, outcome.conversations, outcome.messages, outcome.status, outcome.error ?? null, id)
}

/** Past runs, NEWEST first. A row with `finishedAt: null` is either in flight or died with its
 *  process — the live `running` flag on the status is what tells the two apart. */
export function listBackfillRuns(db: Db, service: string): import("./contract.ts").BackfillRun[] {
  const rows = db
    .prepare(
      `SELECT id, started_at, finished_at, days, conversations, messages, status, error
       FROM backfill_runs WHERE service = ? ORDER BY id DESC LIMIT ${MAX_BACKFILL_RUNS}`,
    )
    .all(service) as {
    id: number
    started_at: number
    finished_at: number | null
    days: number
    conversations: number
    messages: number
    status: string
    error: string | null
  }[]
  return rows.map((r) => ({
    id: r.id,
    startedAt: r.started_at ?? 0,
    finishedAt: r.finished_at ?? null,
    days: r.days ?? 0,
    conversations: r.conversations ?? 0,
    messages: r.messages ?? 0,
    status: r.status === "ok" || r.status === "error" ? r.status : "aborted",
    ...(r.error ? { error: r.error } : {}),
  }))
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

/** The most-recently-seen cached display names, newest first. Backs the search box's bare `from:`
 *  starter list (PSN-115) — `resolvePerson` is a matcher and returns nothing for an empty needle,
 *  so an un-typed operator would otherwise render an empty dropdown. */
export function listRecentUsers(
  db: Db,
  service: string,
  limit = 8,
): { id: string; displayName: string }[] {
  const rows = db
    .prepare(
      `SELECT id, display_name FROM users
       WHERE service = ? AND display_name IS NOT NULL AND display_name <> ''
       ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(service, Math.max(1, limit)) as { id: string; display_name: string }[]
  return rows.map((r) => ({ id: r.id, displayName: r.display_name }))
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

// ---- reply suggestions (ADR-0027) -----------------------------------------
// Candidate replies produced by an agent. Local state: nothing here reaches the provider unless the
// user picks one, edits it in the composer, and presses send himself. Auto-send is out of scope by
// decision 6 — no function in this section sends anything.

interface SuggestionRow {
  id: number
  conv_id: string
  for_msg_id: string | null
  producer: string
  created_at: number
  status: string
  texts: string
  chosen_idx: number | null
  chosen_at: number | null
  sent_msg_id: string | null
  sent_text: string | null
  sent_at: number | null
}

const SUGGESTION_COLS =
  "id, conv_id, for_msg_id, producer, created_at, status, texts, chosen_idx, chosen_at, sent_msg_id, sent_text, sent_at"

/** A batch is live while it can still be acted on: `open` (nothing picked) or `chosen` (picked,
 *  send not yet attributed). `dismissed`/`superseded` are history. */
const LIVE_STATUSES = "('open','chosen')"

/** How long after picking a suggestion a send still counts as coming from it (PSN-145).
 *
 * 10 minutes: long enough for him to pick an option, get pulled into something else, come back and
 * finish editing; short enough that a batch chosen before lunch does not claim credit for whatever
 * he sends after it. The number is a judgement call, not a measurement — if the data shows it is
 * wrong, this is the one line to change. */
const ATTRIBUTION_WINDOW_MS = 10 * 60 * 1000

function shapeSuggestion(r: SuggestionRow): ReplySuggestionBatch {
  return {
    id: r.id,
    convId: r.conv_id,
    forMsgId: r.for_msg_id,
    producer: r.producer,
    createdAt: r.created_at,
    // Narrowed on write (`writeSuggestions` only ever stores one of the four), so a row outside the
    // union means hand-edited SQL — surface it as-is rather than pretending it is `open`.
    status: r.status as ReplySuggestionBatch["status"],
    texts: parseTexts(r.texts),
    chosenIdx: r.chosen_idx,
    chosenAt: r.chosen_at,
    sentMsgId: r.sent_msg_id,
    sentText: r.sent_text,
    sentAt: r.sent_at,
  }
}

/** Defensive: `texts` is written as a JSON string[], but a corrupt row must not take down a thread
 *  load. An empty batch renders as "no suggestions", which is the honest reading of unparseable. */
function parseTexts(raw: string): string[] {
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : []
  } catch {
    return []
  }
}

/** Ceilings on a stored batch. `/api/chat/*` has no auth, so any tailnet caller can POST here, and
 *  every accepted batch is JSON-encoded into one column AND broadcast to every connected client —
 *  one oversized request would otherwise cost memory on all of them plus permanent DB bloat.
 *  The numbers are a UI bound, not a security guess: a strip shows a handful of short replies. */
export const MAX_SUGGESTION_TEXTS = 10
export const MAX_SUGGESTION_TEXT_CHARS = 2000

/**
 * Store a new batch, retiring whatever was live for that conversation.
 *
 * Supersede-then-insert runs in ONE transaction: a caller that regenerates twice quickly must never
 * leave two live batches, or `getSuggestions` has to pick a winner and the UI shows a stale strip.
 *
 * Empty `texts` is rejected rather than stored — a producer that returns nothing has failed, and a
 * zero-length batch would render as an empty strip the user cannot act on or dismiss. Over-long
 * input is rejected rather than truncated: a silently clipped suggestion is one the user might send
 * mid-sentence without noticing.
 */
export function writeSuggestions(
  db: Db,
  service: string,
  input: { convId: string; texts: string[]; producer: string; forMsgId?: string | null },
): ReplySuggestionBatch {
  const texts = input.texts.map((t) => String(t ?? "").trim()).filter(Boolean)
  if (texts.length === 0) throw new Error("writeSuggestions: texts must contain at least one entry")
  if (texts.length > MAX_SUGGESTION_TEXTS)
    throw new Error(`writeSuggestions: at most ${MAX_SUGGESTION_TEXTS} texts`)
  if (texts.some((t) => t.length > MAX_SUGGESTION_TEXT_CHARS))
    throw new Error(`writeSuggestions: each text must be <= ${MAX_SUGGESTION_TEXT_CHARS} chars`)
  const producer = String(input.producer ?? "").trim()
  if (!producer) throw new Error("writeSuggestions: producer is required")

  const now = Date.now()
  const insert = db.transaction((): number => {
    db.prepare(
      `UPDATE reply_suggestions SET status = 'superseded'
         WHERE service = ? AND conv_id = ? AND status IN ${LIVE_STATUSES}`,
    ).run(service, input.convId)
    const r = db
      .prepare(
        `INSERT INTO reply_suggestions
           (service, conv_id, for_msg_id, producer, created_at, status, texts)
         VALUES (?, ?, ?, ?, ?, 'open', ?)`,
      )
      .run(service, input.convId, input.forMsgId ?? null, producer, now, JSON.stringify(texts))
    return Number(r.lastInsertRowid)
  })
  const id = insert()
  const batch = getSuggestionById(db, service, id)
  // Unreachable unless the insert above silently failed; better a loud throw than a null batch
  // broadcast to every client.
  if (!batch) throw new Error("writeSuggestions: insert did not produce a row")
  return batch
}

/** The live batch for a conversation, or null. Newest wins — older live rows should not exist
 *  (see `writeSuggestions`), but ordering by id means a leaked one can never win. */
export function getSuggestions(
  db: Db,
  service: string,
  convId: string,
): ReplySuggestionBatch | null {
  const r = db
    .prepare(
      `SELECT ${SUGGESTION_COLS} FROM reply_suggestions
         WHERE service = ? AND conv_id = ? AND status IN ${LIVE_STATUSES}
         ORDER BY id DESC LIMIT 1`,
    )
    .get(service, convId) as SuggestionRow | undefined
  return r ? shapeSuggestion(r) : null
}

export function getSuggestionById(
  db: Db,
  service: string,
  id: number,
): ReplySuggestionBatch | null {
  const r = db
    .prepare(`SELECT ${SUGGESTION_COLS} FROM reply_suggestions WHERE service = ? AND id = ?`)
    .get(service, id) as SuggestionRow | undefined
  return r ? shapeSuggestion(r) : null
}

/**
 * Record which suggestion the user picked. Does NOT send it — the caller inserts the text into the
 * composer and the user presses send (ADR-0027 decision 6).
 *
 * Re-choosing within a live batch is allowed (he inserted #1, changed his mind, inserted #3) and
 * overwrites `chosen_idx`. A batch that already has a send attributed is frozen: rewriting its
 * choice would break the suggested/sent pair that is the whole reason the row exists.
 */
export function chooseSuggestion(
  db: Db,
  service: string,
  id: number,
  idx: number,
): ReplySuggestionBatch | null {
  const cur = getSuggestionById(db, service, id)
  if (!cur) return null
  if (cur.sentAt !== null) return cur
  if (!Number.isInteger(idx) || idx < 0 || idx >= cur.texts.length) {
    throw new Error(`chooseSuggestion: idx ${idx} out of range for batch of ${cur.texts.length}`)
  }
  db.prepare(
    `UPDATE reply_suggestions SET status = 'chosen', chosen_idx = ?, chosen_at = ?
       WHERE service = ? AND id = ? AND status IN ${LIVE_STATUSES}`,
  ).run(idx, Date.now(), service, id)
  return getSuggestionById(db, service, id)
}

/**
 * Link a sent message back to the batch the user picked from (ADR-0027 decision 4, PSN-145).
 *
 * THIS ATTRIBUTION IS A HEURISTIC AND MUST BE READ AS ONE. All it knows is "this conversation had
 * a chosen batch, and then a message went out". It cannot see the composer, so it will sometimes
 * link a send that had nothing to do with the suggestion: the user inserts a draft, deletes it,
 * types something unrelated, and sends. That row will claim the suggestion led to the send.
 *
 * Fine for a metric — "how often does he send something close to what we drafted" survives some
 * noise. NOT fine as a training label without a human reading the pair first. If a confidence
 * score is ever built on this column, the noise has to be measured, not assumed away.
 *
 * Two guards keep the noise bounded rather than unbounded:
 *  - only a `chosen` batch attributes. An `open` batch means he never picked anything, so a send
 *    cannot be attributed to a choice that did not happen.
 *  - only within `ATTRIBUTION_WINDOW_MS` of the choice. Without a window, a batch chosen this
 *    morning would claim credit for a message sent this evening.
 *
 * First send wins: the batch is frozen once attributed, so a follow-up message in the same
 * conversation does not overwrite the pair.
 *
 * Returns the updated batch when it attributed, else null (no live chosen batch, or too late).
 */
export function attributeSend(
  db: Db,
  service: string,
  convId: string,
  sent: { msgId: string; text: string; at?: number },
): ReplySuggestionBatch | null {
  const cur = getSuggestions(db, service, convId)
  if (!cur) return null
  if (cur.status !== "chosen" || cur.chosenAt === null) return null
  // Already attributed — first send wins, later ones are a different message.
  if (cur.sentAt !== null) return null

  const at = sent.at ?? Date.now()
  if (at - cur.chosenAt > ATTRIBUTION_WINDOW_MS) return null

  db.prepare(
    `UPDATE reply_suggestions SET sent_msg_id = ?, sent_text = ?, sent_at = ?
       WHERE service = ? AND id = ? AND sent_at IS NULL`,
  ).run(sent.msgId, sent.text, at, service, cur.id)
  return getSuggestionById(db, service, cur.id)
}

/** Batches where the user sent something DIFFERENT from what was suggested — the deliverable of
 *  PSN-145. This diff, not the raw count, is what a confidence score would eventually learn from. */
export function listDivergedSends(db: Db, service: string, limit = 100): ReplySuggestionBatch[] {
  const rows = db
    .prepare(
      `SELECT ${SUGGESTION_COLS} FROM reply_suggestions
         WHERE service = ? AND sent_at IS NOT NULL AND chosen_idx IS NOT NULL
         ORDER BY sent_at DESC LIMIT ?`,
    )
    .all(service, limit) as SuggestionRow[]
  return rows
    .map(shapeSuggestion)
    .filter((b) => b.chosenIdx !== null && b.sentText !== b.texts[b.chosenIdx])
}

/** Retire a batch the user does not want. Kept as a row (not deleted): a dismissal is a judgement
 *  on the suggestions, which is exactly the signal this table exists to collect. */
export function dismissSuggestions(db: Db, service: string, id: number): void {
  db.prepare(
    `UPDATE reply_suggestions SET status = 'dismissed'
       WHERE service = ? AND id = ? AND status IN ${LIVE_STATUSES}`,
  ).run(service, id)
}
