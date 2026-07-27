// Per-image rows + their transcriptions (PSN-104). One row per image occurrence in a message, but
// the CAPTION is keyed by the AMS object id — the same screenshot forwarded into three chats is
// transcribed once and the text is copied to the other rows.
//
// Lives beside `store.ts` rather than inside it: the store is already 1k lines, and this table is
// only touched by the ingest hook, the caption worker and the assistant's vision tool.

import type BetterSqlite3 from "better-sqlite3"
import type { MessageImage } from "./media-images.ts"

type Db = BetterSqlite3.Database

export type CaptionStatus = "pending" | "done" | "failed"

export interface MediaRow {
  service: string
  convId: string
  msgId: string
  index: number
  objectId: string
  url: string
  caption: string | null
  status: CaptionStatus
  error: string | null
}

/** Idempotent — called from `store.migrate()`. */
export function migrateMedia(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS message_media (
    service    TEXT NOT NULL,
    conv_id    TEXT NOT NULL,
    msg_id     TEXT NOT NULL,
    idx        INTEGER NOT NULL,
    object_id  TEXT NOT NULL,
    url        TEXT NOT NULL,
    caption    TEXT,
    status     TEXT NOT NULL DEFAULT 'pending',
    error      TEXT,
    updated_at INTEGER,
    PRIMARY KEY (service, conv_id, msg_id, idx)
  )`)
  db.exec("CREATE INDEX IF NOT EXISTS message_media_object ON message_media (service, object_id)")
}

/** Register a message's images. Existing rows keep their caption (a re-sweep of the same message
 *  must not re-queue work); a NEW row inherits a caption already transcribed for the same object.
 *  Returns the rows that still need captioning. */
export function recordMessageImages(
  db: Db,
  service: string,
  convId: string,
  msgId: string,
  images: MessageImage[],
  now: number = Date.now(),
): MediaRow[] {
  if (!images.length) return []
  const existing = db.prepare(
    "SELECT caption, status FROM message_media WHERE service = ? AND conv_id = ? AND msg_id = ? AND idx = ?",
  )
  const cached = db.prepare(
    "SELECT caption FROM message_media WHERE service = ? AND object_id = ? AND status = 'done' LIMIT 1",
  )
  const insert = db.prepare(`
    INSERT INTO message_media (service, conv_id, msg_id, idx, object_id, url, caption, status, updated_at)
    VALUES (@service, @convId, @msgId, @idx, @objectId, @url, @caption, @status, @now)
    ON CONFLICT(service, conv_id, msg_id, idx) DO UPDATE SET
      object_id = excluded.object_id,
      url = excluded.url,
      updated_at = excluded.updated_at
  `)
  const queued: MediaRow[] = []
  const run = db.transaction(() => {
    for (const img of images) {
      const prior = existing.get(service, convId, msgId, img.index) as
        | { caption: string | null; status: CaptionStatus }
        | undefined
      const inherited = prior?.caption
        ? { caption: prior.caption, status: prior.status }
        : ((cached.get(service, img.objectId) as { caption: string } | undefined) ?? null)
      const caption = inherited?.caption ?? null
      const status: CaptionStatus = caption ? "done" : "pending"
      insert.run({
        service,
        convId,
        msgId,
        idx: img.index,
        objectId: img.objectId,
        url: img.url,
        caption,
        status,
        now,
      })
      if (!caption) {
        queued.push({
          service,
          convId,
          msgId,
          index: img.index,
          objectId: img.objectId,
          url: img.url,
          caption: null,
          status: "pending",
          error: null,
        })
      }
    }
  })
  run()
  return queued
}

const toRow = (r: RawRow): MediaRow => ({
  service: r.service,
  convId: r.conv_id,
  msgId: r.msg_id,
  index: r.idx,
  objectId: r.object_id,
  url: r.url,
  caption: r.caption,
  status: r.status,
  error: r.error,
})

interface RawRow {
  service: string
  conv_id: string
  msg_id: string
  idx: number
  object_id: string
  url: string
  caption: string | null
  status: CaptionStatus
  error: string | null
}

const SELECT =
  "SELECT service, conv_id, msg_id, idx, object_id, url, caption, status, error FROM message_media"

/** One message's images, in document order. */
export function listMessageImages(
  db: Db,
  service: string,
  convId: string,
  msgId: string,
): MediaRow[] {
  return (
    db
      .prepare(`${SELECT} WHERE service = ? AND conv_id = ? AND msg_id = ? ORDER BY idx`)
      .all(service, convId, msgId) as RawRow[]
  ).map(toRow)
}

/** Rows for one AMS object (the same image wherever it was posted). */
export function findByObjectId(db: Db, service: string, objectId: string): MediaRow[] {
  return (
    db
      .prepare(`${SELECT} WHERE service = ? AND object_id = ? ORDER BY idx`)
      .all(service, objectId) as RawRow[]
  ).map(toRow)
}

/** Transcriptions attached to one message, in order. Pending/failed images contribute nothing. */
export function captionsForMessage(
  db: Db,
  service: string,
  convId: string,
  msgId: string,
): string[] {
  return (
    db
      .prepare(
        "SELECT caption FROM message_media WHERE service = ? AND conv_id = ? AND msg_id = ? AND caption IS NOT NULL ORDER BY idx",
      )
      .all(service, convId, msgId) as { caption: string }[]
  ).map((r) => r.caption)
}

/** Store a transcription against EVERY row sharing that object id. Returns the messages touched,
 *  so the caller can re-index them (a caption is searchable text) and push a delta. */
export function setCaption(
  db: Db,
  service: string,
  objectId: string,
  caption: string,
  now: number = Date.now(),
): { convId: string; msgId: string }[] {
  const touched = db
    .prepare(
      "SELECT DISTINCT conv_id, msg_id FROM message_media WHERE service = ? AND object_id = ?",
    )
    .all(service, objectId) as { conv_id: string; msg_id: string }[]
  db.prepare(
    "UPDATE message_media SET caption = ?, status = 'done', error = NULL, updated_at = ? WHERE service = ? AND object_id = ?",
  ).run(caption, now, service, objectId)
  return touched.map((t) => ({ convId: t.conv_id, msgId: t.msg_id }))
}

/** Mark an object's rows failed. The image still renders and `view_image` still works — only the
 *  transcription is missing, so this is never fatal. */
export function setCaptionError(
  db: Db,
  service: string,
  objectId: string,
  error: string,
  now: number = Date.now(),
): void {
  db.prepare(
    "UPDATE message_media SET status = 'failed', error = ?, updated_at = ? WHERE service = ? AND object_id = ? AND caption IS NULL",
  ).run(String(error).slice(0, 500), now, service, objectId)
}
