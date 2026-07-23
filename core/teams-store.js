// Server-owned SQLite chat store for the Teams chat app (t127, ADR-0019). The single source
// of truth for chat state; clients keep a light cache and sync over the existing SSE/WS
// (mirrors ADR-0017 pins/history). The `better-sqlite3` handle is injected — this module has
// no `require("better-sqlite3")`, so it's testable against an in-memory (`:memory:`) db and
// the native module is only loaded by the web server (never bundled into Electron; Electron
// is a shell that loads the served URL). See ADR-0019.
//
// t127 creates the WHOLE schema (so later tasks never migrate) but only WRITES `accounts` +
// `conversations`. `messages`, `read_state`, and the FTS index ship as migration-only.

// The full schema. `CREATE … IF NOT EXISTS` makes migrate() idempotent (safe to run on
// every boot). Cursor columns (newest_synced_ts / oldest_synced_ts) let t129+ page a
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
    last_message_from_me INTEGER DEFAULT 0,
    newest_synced_ts     INTEGER,
    oldest_synced_ts     INTEGER,
    muted                INTEGER DEFAULT 0,
    updated_at           INTEGER
  )`,
  // Written t129+ — schema only for now.
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
  // Written t130+ — schema only for now.
  `CREATE TABLE IF NOT EXISTS read_state (
    conv_id         TEXT PRIMARY KEY,
    tenant          TEXT,
    read_horizon_ts INTEGER,
    local_read_ts   INTEGER
  )`,
  // Display-name cache keyed by MRI (t131). DMs/group-DMs carry no topic, so their title is
  // built from member names resolved via Graph — cached here so it's a one-time lookup per person
  // (name resolution is the expensive part; a re-render must not re-hit Graph).
  `CREATE TABLE IF NOT EXISTS users (
    mri          TEXT PRIMARY KEY,
    display_name TEXT,
    updated_at   INTEGER
  )`,
  // Populated later (search is a deferred default) — external-content FTS over `messages`.
  `CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content, content='messages')`,
  // Per-conversation LOCAL organisation (t156, Workstream K): labels, one folder, and a local mute.
  // All local to this store — NEVER written back to Teams. Shared across every device that talks to
  // this server (not device-keyed, by design). `labels` is a JSON string array.
  `CREATE TABLE IF NOT EXISTS conversation_prefs (
    conv_id TEXT PRIMARY KEY,
    labels  TEXT,
    folder  TEXT,
    muted   INTEGER DEFAULT 0
  )`,
]

// Columns added after t127's original schema. `CREATE TABLE IF NOT EXISTS` won't add a column to a
// pre-existing table, so ALTER them in idempotently (swallow the "duplicate column" error on a db
// that already has them). Keep new columns here, not in SCHEMA, so an existing db.migrate()s cleanly.
const ADD_COLUMNS = [
  ["conversations", "last_message_from_me", "INTEGER DEFAULT 0"], // t155
  ["conversation_prefs", "muted_until", "INTEGER"], // t167: timed mute expiry (epoch ms; NULL = forever)
  ["conversation_prefs", "notify_on_mention", "INTEGER DEFAULT 0"], // t167: push through a mute on @me
]

function migrate(db) {
  for (const stmt of SCHEMA) db.exec(stmt)
  for (const [table, col, type] of ADD_COLUMNS) {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`)
    } catch (e) {
      if (!/duplicate column/i.test(e.message)) throw e
    }
  }
  return db
}

// Reserved conversations to skip. Teams uses the `48:` namespace for non-chat threads:
// `48:notes` (the self "chat with yourself" / "Notes"), `48:notifications`, `48:mentions`. Only
// `48:notes` is a real chat (it has a lastMessage), so it enters the store; the others never do.
function isReservedConversation(id) {
  return typeof id === "string" && id.startsWith("48:") && id !== "48:notes"
}

// `48:notes` is the self chat; 1:1 chat ids end `@unq.gbl.spaces`; group chats are `…@thread.v2`.
// Everything else that isn't reserved is treated as a group thread.
function conversationKind(id) {
  if (id === "48:notes") return "self"
  return typeof id === "string" && id.includes("@unq.gbl.spaces") ? "oneOnOne" : "group"
}

// ISO-8601 (Teams `originalarrivaltime` / `composetime`) → epoch ms, or null.
function toEpochMs(iso) {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : null
}

const PREVIEW_CAP = 500

// Teams' server-side read horizon (t155). Every Teams client (desktop/mobile/web) writes the
// conversation's `properties.consumptionhorizon` as "{lastReadMsgId};{readTsMs};{clientVersion}"
// — the middle field is the epoch-ms up to which the user has read ANYWHERE. Ingesting it keeps
// the chat app's unread honest when a message is read on another device. Returns null on any
// unparseable shape (never rewinds the horizon on garbage).
function parseConsumptionHorizonTs(raw) {
  if (typeof raw !== "string") return null
  const parts = raw.split(";")
  const ts = Number(parts[1])
  return Number.isFinite(ts) && ts > 0 ? ts : null
}

// Pure: a raw Teams conversation object → the DB row shape (message rendering/sanitizing is
// t129, so the preview is the raw last-message content, capped). `lastUpdatedMessageVersion`
// drives the version gate; the last message's arrival time is the sort/anchor timestamp.
// `selfId` (the signed-in oid, t155) flags whether the last message is the viewer's own — an
// own last message never badges unread. `read_horizon_ts` carries the Teams consumptionhorizon.
function shapeConversation(conv, tenant, selfId) {
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
    last_message_from_me: isSelfLastMessage(last.from, selfId) ? 1 : 0,
    read_horizon_ts: parseConsumptionHorizonTs(conv.properties?.consumptionhorizon),
    muted: 0,
  }
}

// The last message's `from` MRI (`8:orgid:<oid>` or a contacts URL tail) is the viewer's own when
// its oid tail matches the signed-in oid. Mirrors teams-render's isSelf without importing it.
function isSelfLastMessage(from, selfId) {
  if (!selfId || typeof from !== "string" || !from) return false
  const sender = from.split("/").pop() || from
  const oid = (v) => (typeof v === "string" ? v.slice(v.lastIndexOf(":") + 1) : "")
  return sender === selfId || oid(sender) === oid(selfId)
}

// Insert new conversations, update a row only when its `lastUpdatedMessageVersion` rises
// (no-op on equal/lower — the WHERE gate), and skip reserved/self. The newest/oldest sync
// cursors are seeded to the last-message ts ONCE on insert and never clobbered by an update
// (t129+ owns their advance). Returns the shaped, non-reserved rows it processed.
function upsertConversations(db, tenant, list, now = Date.now(), selfId = null) {
  const stmt = db.prepare(`
    INSERT INTO conversations
      (id, tenant, kind, topic, last_message_id, last_message_version, last_message_ts,
       last_message_preview, last_message_from_me, newest_synced_ts, oldest_synced_ts, muted, updated_at)
    VALUES
      (@id, @tenant, @kind, @topic, @last_message_id, @last_message_version, @last_message_ts,
       @last_message_preview, @last_message_from_me, @last_message_ts, @last_message_ts, @muted, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      tenant = excluded.tenant,
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
  const rows = []
  const run = db.transaction((convs) => {
    for (const conv of convs) {
      if (!conv?.id || isReservedConversation(conv.id)) continue
      const row = shapeConversation(conv, tenant, selfId)
      stmt.run({ ...row, updated_at: now })
      // Ingest the Teams server-side read horizon (read-elsewhere) into read_state. Monotonic
      // (setReadHorizon MAXes), so it only ever advances — a mark-unread's local sentinel still wins.
      if (row.read_horizon_ts != null) setReadHorizon(db, tenant, conv.id, row.read_horizon_ts)
      rows.push(row)
    }
  })
  run(list || [])
  return rows
}

// Upsert the single signed-in account (t127 writes this alongside conversations). Keyed by
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
// route returns and t128's list UI reads.
function listConversations(db, tenant) {
  const rows = db
    .prepare(`
      SELECT c.id, c.kind, c.topic, c.last_message_id, c.last_message_version, c.last_message_ts,
             c.last_message_preview, c.last_message_from_me, c.muted,
             r.read_horizon_ts, r.local_read_ts
      FROM conversations c
      LEFT JOIN read_state r ON r.conv_id = c.id
      WHERE c.tenant = ?
      ORDER BY c.last_message_ts DESC NULLS LAST, c.id
    `)
    .all(tenant)
  return rows.map((r) => {
    // `local_read_ts === -1` is the sticky mark-unread sentinel (t155): the row stays unread even
    // if the Teams horizon covers the last message. `readTs` is the effective read watermark the
    // client derives unread against; the sentinel forces it to 0. Otherwise the higher of the two.
    const sticky = r.local_read_ts === -1
    const readTs = sticky
      ? 0
      : Math.max(r.read_horizon_ts || 0, r.local_read_ts > 0 ? r.local_read_ts : 0)
    return {
      id: r.id,
      kind: r.kind,
      topic: r.topic,
      lastMessageId: r.last_message_id,
      lastMessageVersion: r.last_message_version,
      lastMessageTs: r.last_message_ts,
      lastMessagePreview: r.last_message_preview,
      lastMessageFromMe: !!r.last_message_from_me,
      readTs,
      unreadSticky: sticky,
      muted: !!r.muted,
    }
  })
}

// Persist a page of ReaderMessages (t129, ADR-0019) into `messages`, insert-or-replace by
// (conv_id, id) so a re-fetch or an edit overwrites in place. Bodies are pre-rendered plain text
// (teams-render), so `content` holds display text — no re-sanitizing on read. `version` is stored
// when the caller carries it (t131 reconcile gate); ReaderMessage v1 omits it → null. Advances the
// conversation's sync cursors to span the page (oldest down, newest up) so paging resumes across
// restarts. `msgs` is the toReaderMessages output; empty is a no-op.
function upsertMessages(db, tenant, convId, msgs, now = Date.now()) {
  const list = Array.isArray(msgs) ? msgs.filter((m) => m?.id) : []
  if (list.length === 0) return
  const stmt = db.prepare(`
    INSERT INTO messages
      (conv_id, id, tenant, version, sender_id, sender_name, ts, content, deleted, edited)
    VALUES
      (@conv_id, @id, @tenant, @version, @sender_id, @sender_name, @ts, @content, @deleted, @edited)
    ON CONFLICT(conv_id, id) DO UPDATE SET
      version = excluded.version,
      sender_id = excluded.sender_id,
      sender_name = excluded.sender_name,
      ts = excluded.ts,
      content = excluded.content,
      deleted = excluded.deleted,
      edited = excluded.edited
  `)
  const advance = db.prepare(`
    UPDATE conversations SET
      newest_synced_ts = MAX(COALESCE(newest_synced_ts, 0), @newest),
      oldest_synced_ts = MIN(COALESCE(oldest_synced_ts, @oldest), @oldest),
      updated_at = @now
    WHERE id = @convId AND tenant = @tenant
  `)
  const run = db.transaction((rows) => {
    let oldest = Number.POSITIVE_INFINITY
    let newest = Number.NEGATIVE_INFINITY
    for (const m of rows) {
      const ts = Number(m.ts) || 0
      stmt.run({
        conv_id: convId,
        id: String(m.id),
        tenant,
        version: Number.isFinite(m.version) ? m.version : null,
        sender_id: m.senderId || null,
        sender_name: m.senderName || null,
        ts,
        content: m.body || "",
        deleted: m.deleted ? 1 : 0,
        edited: m.edited ? 1 : 0,
      })
      if (ts > 0) {
        if (ts < oldest) oldest = ts
        if (ts > newest) newest = ts
      }
    }
    if (Number.isFinite(oldest) && Number.isFinite(newest)) {
      advance.run({ convId, tenant, oldest, newest, now })
    }
  })
  run(list)
}

// A conversation's stored messages, newest-first (the thread view reverses for display). `before`
// is a ts cursor (exclusive) for lazy older-page loads; `limit` caps the page (default 30). Bodies
// are already rendered plain text. `self` is NOT stored — the caller recomputes it against the
// signed-in account when this backs a response (t130); v1 fetches self fresh from toReaderMessages.
function listMessages(db, tenant, convId, opts = {}) {
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : 30
  const before = Number.isFinite(opts.before) ? opts.before : null
  const rows = db
    .prepare(`
      SELECT id, version, sender_id, sender_name, ts, content, deleted, edited
      FROM messages
      WHERE conv_id = @convId AND tenant = @tenant
        AND (@before IS NULL OR ts < @before)
      ORDER BY ts DESC, id DESC
      LIMIT @limit
    `)
    .all({ convId, tenant, before, limit })
  return rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    version: r.version,
    senderId: r.sender_id,
    senderName: r.sender_name,
    body: r.content,
    edited: !!r.edited,
    deleted: !!r.deleted,
  }))
}

// ---- read state (t130, ADR-0019) ------------------------------------------
// Q9 hybrid: `local_read_ts` advances when a conversation is OPENED (a local read — no Teams
// write), `read_horizon_ts` advances on a write-through mark-read (a reply or explicit action
// that also pushed the consumptionHorizon to Teams). Both are monotonic (MAX guard) so a
// stale/older ts never rewinds the horizon. Written independently — one call never clobbers the
// other's column.

function setReadHorizon(db, tenant, convId, ts) {
  db.prepare(`
    INSERT INTO read_state (conv_id, tenant, read_horizon_ts)
    VALUES (@convId, @tenant, @ts)
    ON CONFLICT(conv_id) DO UPDATE SET
      tenant = excluded.tenant,
      read_horizon_ts = MAX(COALESCE(read_state.read_horizon_ts, 0), excluded.read_horizon_ts)
  `).run({ convId, tenant, ts: Number(ts) || 0 })
}

function setLocalRead(db, tenant, convId, ts) {
  db.prepare(`
    INSERT INTO read_state (conv_id, tenant, local_read_ts)
    VALUES (@convId, @tenant, @ts)
    ON CONFLICT(conv_id) DO UPDATE SET
      tenant = excluded.tenant,
      local_read_ts = MAX(COALESCE(read_state.local_read_ts, 0), excluded.local_read_ts)
  `).run({ convId, tenant, ts: Number(ts) || 0 })
}

// Explicit mark-read (t155): force local_read_ts to `ts` (the last-message ts), clearing any
// mark-unread sentinel. Unlike setLocalRead this is NOT monotonic — an explicit action overrides,
// so it can drop a -1 sentinel back to a real read ts. Idempotent.
function markConversationRead(db, tenant, convId, ts) {
  db.prepare(`
    INSERT INTO read_state (conv_id, tenant, local_read_ts)
    VALUES (@convId, @tenant, @ts)
    ON CONFLICT(conv_id) DO UPDATE SET tenant = excluded.tenant, local_read_ts = excluded.local_read_ts
  `).run({ convId, tenant, ts: Number(ts) || 0 })
}

// Explicit mark-unread (t155): set the sticky sentinel local_read_ts = -1. The row then reads
// unread regardless of the Teams horizon (which keeps advancing in read_state but is masked by the
// sentinel in listConversations) until a real read (open/mark-read) overwrites it. Re-arms the to-do dot.
function markConversationUnread(db, tenant, convId) {
  db.prepare(`
    INSERT INTO read_state (conv_id, tenant, local_read_ts)
    VALUES (@convId, @tenant, -1)
    ON CONFLICT(conv_id) DO UPDATE SET tenant = excluded.tenant, local_read_ts = -1
  `).run({ convId, tenant })
}

function getReadState(db, convId) {
  const r = db
    .prepare("SELECT tenant, read_horizon_ts, local_read_ts FROM read_state WHERE conv_id = ?")
    .get(convId)
  if (!r) return null
  return { tenant: r.tenant, readHorizonTs: r.read_horizon_ts, localReadTs: r.local_read_ts }
}

// ---- user display-name cache (t131, ADR-0019) -----------------------------
// Insert-or-update names keyed by MRI. `list` is [{ mri, displayName }]; rows missing either
// field are skipped (a Graph miss shouldn't cache a blank name). Empty list is a no-op.
function upsertUsers(db, list, now = Date.now()) {
  const rows = (Array.isArray(list) ? list : []).filter((u) => u?.mri && u?.displayName)
  if (rows.length === 0) return
  const stmt = db.prepare(`
    INSERT INTO users (mri, display_name, updated_at)
    VALUES (@mri, @display_name, @updated_at)
    ON CONFLICT(mri) DO UPDATE SET
      display_name = excluded.display_name,
      updated_at = excluded.updated_at
  `)
  const run = db.transaction((us) => {
    for (const u of us) stmt.run({ mri: u.mri, display_name: u.displayName, updated_at: now })
  })
  run(rows)
}

// The cached names for a set of MRIs → Map(mri → displayName). Only the hits are present, so the
// caller diffs the requested MRIs against the map keys to find the misses to resolve. Empty list
// → empty map (no query).
function getUsers(db, mris) {
  const map = new Map()
  const ids = Array.isArray(mris) ? mris.filter(Boolean) : []
  if (ids.length === 0) return map
  const placeholders = ids.map(() => "?").join(",")
  const rows = db
    .prepare(`SELECT mri, display_name FROM users WHERE mri IN (${placeholders})`)
    .all(ids)
  for (const r of rows) map.set(r.mri, r.display_name)
  return map
}

// ---- conversation prefs (t156, Workstream K) ------------------------------
// LOCAL labels / folder / mute per conversation — never written to Teams. Shared across devices
// (server-side, not device-keyed). `labels` persists as a JSON string array.

// Whether a pref row is muted RIGHT NOW (t167): muted with no expiry = forever; a `mutedUntil` in
// the future = still muted; past = the mute has expired (treated unmuted — no cleanup write needed,
// the predicate is the truth). Pure; mirrored in chat/src/lib/conversation-view.ts.
function isMutedNow(prefs, now = Date.now()) {
  if (!prefs || !prefs.muted) return false
  return prefs.mutedUntil == null || now < prefs.mutedUntil
}

function shapePrefs(r) {
  return {
    labels: parseLabels(r.labels),
    folder: r.folder || null,
    muted: !!r.muted,
    mutedUntil: r.muted_until ?? null,
    notifyOnMention: !!r.notify_on_mention,
  }
}

// One conversation's prefs, or the empty default (no row = no labels, no folder, not muted).
function getPrefs(db, convId) {
  const r = db
    .prepare(
      "SELECT labels, folder, muted, muted_until, notify_on_mention FROM conversation_prefs WHERE conv_id = ?",
    )
    .get(convId)
  if (!r)
    return { labels: [], folder: null, muted: false, mutedUntil: null, notifyOnMention: false }
  return shapePrefs(r)
}

// Every conversation's prefs → Map(convId → {labels, folder, muted, mutedUntil, notifyOnMention}).
// The client fetches this once on boot + after each write, holds it alongside the list, and
// re-applies over polled rows (so a poll can't clobber a pref). Empty folder/label rows are still
// returned (the write may have cleared them) — the client treats an all-empty pref as "ungrouped,
// no labels, unmuted".
function getAllPrefs(db) {
  const map = {}
  for (const r of db
    .prepare(
      "SELECT conv_id, labels, folder, muted, muted_until, notify_on_mention FROM conversation_prefs",
    )
    .all()) {
    map[r.conv_id] = shapePrefs(r)
  }
  return map
}

// Patch a conversation's prefs (upsert). Only the provided keys change; the rest keep their stored
// value (COALESCE against the existing row). `labels` (array) is stored as JSON; `folder` ("" → null
// to un-file); `muted` (bool → 0/1); `mutedUntil` (t167: epoch ms or null = forever — setting
// `muted` without it clears any old expiry so "mute forever" can't inherit a stale window);
// `notifyOnMention` (bool → 0/1). Returns the row's full prefs after the write.
function setPrefs(db, convId, patch) {
  const cur = getPrefs(db, convId)
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
        ? patch.mutedUntil
        : null
      : patch.mutedUntil !== undefined
        ? Number.isFinite(patch.mutedUntil)
          ? patch.mutedUntil
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
  db.prepare(`
    INSERT INTO conversation_prefs (conv_id, labels, folder, muted, muted_until, notify_on_mention)
    VALUES (@convId, @labels, @folder, @muted, @mutedUntil, @notifyOnMention)
    ON CONFLICT(conv_id) DO UPDATE SET labels = excluded.labels, folder = excluded.folder,
      muted = excluded.muted, muted_until = excluded.muted_until, notify_on_mention = excluded.notify_on_mention
  `).run({ convId, labels: JSON.stringify(labels), folder, muted, mutedUntil, notifyOnMention })
  return { labels, folder, muted: !!muted, mutedUntil, notifyOnMention: !!notifyOnMention }
}

function parseLabels(raw) {
  if (typeof raw !== "string" || !raw) return []
  try {
    const v = JSON.parse(raw)
    return sanitizeLabels(v)
  } catch {
    return []
  }
}

// Trim, drop empties, dedupe, cap length — a label is a short free-form tag.
function sanitizeLabels(v) {
  if (!Array.isArray(v)) return []
  const out = []
  for (const s of v) {
    const t = String(s || "")
      .trim()
      .slice(0, 40)
    if (t && !out.includes(t)) out.push(t)
  }
  return out
}

module.exports = {
  migrate,
  getPrefs,
  getAllPrefs,
  setPrefs,
  isMutedNow,
  isReservedConversation,
  conversationKind,
  shapeConversation,
  upsertConversations,
  upsertAccount,
  listConversations,
  upsertMessages,
  listMessages,
  setReadHorizon,
  setLocalRead,
  markConversationRead,
  markConversationUnread,
  parseConsumptionHorizonTs,
  getReadState,
  upsertUsers,
  getUsers,
}
