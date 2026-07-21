// Server-owned SQLite chat store for the Teams chat app (t105, ADR-0018). The single source
// of truth for chat state; clients keep a light cache and sync over the existing SSE/WS
// (mirrors ADR-0017 pins/history). The `better-sqlite3` handle is injected — this module has
// no `require("better-sqlite3")`, so it's testable against an in-memory (`:memory:`) db and
// the native module is only loaded by the web server (never bundled into Electron; Electron
// is a shell that loads the served URL). See ADR-0018.
//
// t105 creates the WHOLE schema (so later tasks never migrate) but only WRITES `accounts` +
// `conversations`. `messages`, `read_state`, and the FTS index ship as migration-only.

// The full schema. `CREATE … IF NOT EXISTS` makes migrate() idempotent (safe to run on
// every boot). Cursor columns (newest_synced_ts / oldest_synced_ts) let t107+ page a
// conversation forward + backward, both resumable across restarts.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS accounts (
    tenant            TEXT PRIMARY KEY,
    user_id           TEXT,
    display_name      TEXT,
    chat_service_base TEXT,
    updated_at        INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS conversations (
    id                   TEXT PRIMARY KEY,
    tenant               TEXT,
    kind                 TEXT,
    topic                TEXT,
    last_message_id      TEXT,
    last_message_version INTEGER,
    last_message_ts      INTEGER,
    last_message_preview TEXT,
    newest_synced_ts     INTEGER,
    oldest_synced_ts     INTEGER,
    muted                INTEGER DEFAULT 0,
    updated_at           INTEGER
  )`,
  // Written t107+ — schema only for now.
  `CREATE TABLE IF NOT EXISTS messages (
    conv_id     TEXT,
    id          TEXT,
    tenant      TEXT,
    version     INTEGER,
    sender_id   TEXT,
    sender_name TEXT,
    ts          INTEGER,
    content     TEXT,
    deleted     INTEGER DEFAULT 0,
    edited      INTEGER DEFAULT 0,
    PRIMARY KEY (conv_id, id)
  )`,
  // Written t108+ — schema only for now.
  `CREATE TABLE IF NOT EXISTS read_state (
    conv_id         TEXT PRIMARY KEY,
    tenant          TEXT,
    read_horizon_ts INTEGER,
    local_read_ts   INTEGER
  )`,
  // Populated later (search is a deferred default) — external-content FTS over `messages`.
  `CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content, content='messages')`,
]

function migrate(db) {
  for (const stmt of SCHEMA) db.exec(stmt)
  return db
}

// Reserved / self conversations to skip. Teams uses the `48:` namespace for non-chat threads:
// `48:notes` (the self "chat with yourself"), `48:notifications`, `48:mentions`. None are real
// conversations, so they never enter the store.
function isReservedConversation(id) {
  return typeof id === "string" && id.startsWith("48:")
}

// 1:1 chat ids end `@unq.gbl.spaces`; group chats are `…@thread.v2`. Everything else that
// isn't reserved is treated as a group thread.
function conversationKind(id) {
  return typeof id === "string" && id.includes("@unq.gbl.spaces") ? "oneOnOne" : "group"
}

// ISO-8601 (Teams `originalarrivaltime` / `composetime`) → epoch ms, or null.
function toEpochMs(iso) {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : null
}

const PREVIEW_CAP = 500

// Pure: a raw Teams conversation object → the DB row shape (message rendering/sanitizing is
// t107, so the preview is the raw last-message content, capped). `lastUpdatedMessageVersion`
// drives the version gate; the last message's arrival time is the sort/anchor timestamp.
function shapeConversation(conv, tenant) {
  const last = conv.lastMessage || {}
  const content = typeof last.content === "string" ? last.content : ""
  return {
    id: conv.id,
    tenant,
    kind: conversationKind(conv.id),
    topic: conv.threadProperties?.topic || null,
    last_message_id: conv.lastUpdatedMessageId || last.id || null,
    last_message_version: Number(conv.lastUpdatedMessageVersion) || 0,
    last_message_ts: toEpochMs(last.originalarrivaltime) ?? toEpochMs(last.composetime),
    last_message_preview: content.length > PREVIEW_CAP ? content.slice(0, PREVIEW_CAP) : content,
    muted: 0,
  }
}

// Insert new conversations, update a row only when its `lastUpdatedMessageVersion` rises
// (no-op on equal/lower — the WHERE gate), and skip reserved/self. The newest/oldest sync
// cursors are seeded to the last-message ts ONCE on insert and never clobbered by an update
// (t107+ owns their advance). Returns the shaped, non-reserved rows it processed.
function upsertConversations(db, tenant, list, now = Date.now()) {
  const stmt = db.prepare(`
    INSERT INTO conversations
      (id, tenant, kind, topic, last_message_id, last_message_version, last_message_ts,
       last_message_preview, newest_synced_ts, oldest_synced_ts, muted, updated_at)
    VALUES
      (@id, @tenant, @kind, @topic, @last_message_id, @last_message_version, @last_message_ts,
       @last_message_preview, @last_message_ts, @last_message_ts, @muted, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      tenant = excluded.tenant,
      kind = excluded.kind,
      topic = excluded.topic,
      last_message_id = excluded.last_message_id,
      last_message_version = excluded.last_message_version,
      last_message_ts = excluded.last_message_ts,
      last_message_preview = excluded.last_message_preview,
      updated_at = excluded.updated_at
    WHERE excluded.last_message_version > conversations.last_message_version
  `)
  const rows = []
  const run = db.transaction((convs) => {
    for (const conv of convs) {
      if (!conv?.id || isReservedConversation(conv.id)) continue
      const row = shapeConversation(conv, tenant)
      stmt.run({ ...row, updated_at: now })
      rows.push(row)
    }
  })
  run(list || [])
  return rows
}

// Upsert the single signed-in account (t105 writes this alongside conversations). Keyed by
// tenant so a multi-account switcher slots in later without a schema change (decision 11).
function upsertAccount(db, account, now = Date.now()) {
  db.prepare(`
    INSERT INTO accounts (tenant, user_id, display_name, chat_service_base, updated_at)
    VALUES (@tenant, @user_id, @display_name, @chat_service_base, @updated_at)
    ON CONFLICT(tenant) DO UPDATE SET
      user_id = excluded.user_id,
      display_name = COALESCE(excluded.display_name, accounts.display_name),
      chat_service_base = excluded.chat_service_base,
      updated_at = excluded.updated_at
  `).run({
    tenant: account.tenant,
    user_id: account.userId || null,
    display_name: account.displayName || null,
    chat_service_base: account.chatServiceBase || null,
    updated_at: now,
  })
}

// The conversation list for a tenant, newest-first — the shape the /api/teams/conversations
// route returns and t106's list UI reads.
function listConversations(db, tenant) {
  const rows = db
    .prepare(`
      SELECT id, kind, topic, last_message_id, last_message_version, last_message_ts,
             last_message_preview, muted
      FROM conversations
      WHERE tenant = ?
      ORDER BY last_message_ts DESC NULLS LAST, id
    `)
    .all(tenant)
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    topic: r.topic,
    lastMessageId: r.last_message_id,
    lastMessageVersion: r.last_message_version,
    lastMessageTs: r.last_message_ts,
    lastMessagePreview: r.last_message_preview,
    muted: !!r.muted,
  }))
}

module.exports = {
  migrate,
  isReservedConversation,
  conversationKind,
  shapeConversation,
  upsertConversations,
  upsertAccount,
  listConversations,
}
