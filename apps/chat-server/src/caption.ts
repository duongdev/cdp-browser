// Image transcription worker (PSN-104). Inline images are registered by `upsertMessages`; this
// drains the `message_media` rows they leave behind, asks a vision model to transcribe each one,
// and writes the text back — which re-indexes the message, so a phrase that exists only inside a
// screenshot becomes searchable.
//
// The TABLE is the queue (grilled: async, never blocking the sweep). No in-memory list to lose on
// restart, no hook back into the write path, and a crash mid-caption just leaves the row pending.
// Captioning uses its own cheap model (`LLM_CAPTION_MODEL`, falling back to `LLM_MODEL`) — a big
// reasoning model per screenshot is a waste.
//
// Failure is never fatal: the row goes `failed`, the message keeps its text, and the image is still
// viewable and still `view_image`-able by a vision model.

import { generateText, type LanguageModel } from "ai"
import type BetterSqlite3 from "better-sqlite3"
import { CAPTION_PROMPT } from "./media-images.ts"
import { findByObjectId, type MediaRow, setCaption, setCaptionError } from "./media-store.ts"
import type { ChatProvider } from "./providers/provider.ts"
import { reindexMessage } from "./store.ts"

type Db = BetterSqlite3.Database

/** How often the worker looks for pending rows, and how many it takes per tick. Deliberately small:
 *  a burst of screenshots should trickle through the router, not stampede it. */
const TICK_MS = 5_000
const BATCH = 2

export interface CaptionDeps {
  db: Db
  service: string
  provider: Pick<ChatProvider, "media">
  /** The vision model to transcribe with; null disables captioning (no LLM configured). */
  getModel: () => LanguageModel | null
  /** Called for each message a landed transcription touched (tests observe the queue this way).
   *  No WS delta: the lightbox's caption request awaits the same in-flight job, so there is
   *  nothing a push would tell it that the response doesn't. */
  onCaption?: (row: { convId: string; msgId: string; objectId: string; caption: string }) => void
  /** Injectable for tests. */
  now?: () => number
}

export interface Captioner {
  start(): void
  stop(): void
  /** Transcribe one image now (lightbox open / assistant asked). Returns the caption, or null when
   *  captioning is unavailable or failed. Already-captioned images return instantly. */
  captionObject(objectId: string): Promise<string | null>
  /** Drain up to `BATCH` pending rows once. Exposed for tests. */
  tick(): Promise<void>
}

export function createCaptioner(deps: CaptionDeps): Captioner {
  const { db, service, provider } = deps
  const now = deps.now || (() => Date.now())
  let timer: NodeJS.Timeout | null = null
  let running = false
  // One object is only ever captioned once concurrently — the lightbox and the worker routinely
  // want the same image at the same moment.
  const inflight = new Map<string, Promise<string | null>>()

  async function transcribe(row: MediaRow): Promise<string | null> {
    const model = deps.getModel()
    if (!model) return null
    const media = await provider.media(row.url)
    if ("miss" in media) throw new Error("media_miss")
    const { data, mediaType } = await downscaleImage(media.body, media.contentType)
    const out = await generateText({
      model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: CAPTION_PROMPT },
            { type: "file", data, mediaType },
          ],
        },
      ],
      abortSignal: AbortSignal.timeout(120_000),
    })
    const text = out.text.trim()
    // An empty completion is a failure, not an empty caption. A vision-incapable model (or one the
    // router silently downgrades) answers every image with "" — returning null here left the row
    // `pending`, so the worker re-picked the same BATCH forever and no other image was ever
    // captioned. Throwing marks it `failed` and lets the queue advance.
    if (!text) throw new Error("empty_caption")
    return text
  }

  async function captionObject(objectId: string): Promise<string | null> {
    const rows = findByObjectId(db, service, objectId)
    const done = rows.find((r) => r.caption)
    if (done?.caption) return done.caption
    if (!rows.length) return null
    const pending = inflight.get(objectId)
    if (pending) return pending
    const job = (async () => {
      try {
        const caption = await transcribe(rows[0])
        if (!caption) {
          setCaptionError(db, service, objectId, "empty_caption", now())
          return null
        }
        for (const t of setCaption(db, service, objectId, caption, now())) {
          reindexMessage(db, service, t.convId, t.msgId)
          deps.onCaption?.({ ...t, objectId, caption })
        }
        return caption
      } catch (e) {
        setCaptionError(db, service, objectId, (e as Error)?.message || String(e), now())
        console.warn(`[caption] ${objectId}: ${(e as Error)?.message ?? e}`)
        return null
      } finally {
        inflight.delete(objectId)
      }
    })()
    inflight.set(objectId, job)
    return job
  }

  async function tick(): Promise<void> {
    if (running || !deps.getModel()) return
    running = true
    try {
      const pending = db
        .prepare(
          "SELECT DISTINCT object_id FROM message_media WHERE service = ? AND status = 'pending' LIMIT ?",
        )
        .all(service, BATCH) as { object_id: string }[]
      for (const p of pending) await captionObject(p.object_id)
    } finally {
      running = false
    }
  }

  return {
    start() {
      if (timer) return
      timer = setInterval(() => {
        void tick()
      }, TICK_MS)
      timer.unref?.()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
    captionObject,
    tick,
  }
}

/** Long edge a transcribed/viewed image is shrunk to before it goes to the model. A 4K screenshot
 *  costs several times the tokens of a 1024px one and reads no better. */
const MAX_EDGE = 1024

let sharpModule: unknown | null | undefined

/** Downscale via `sharp` when it is installed and the bytes decode; otherwise pass the original
 *  through untouched. Never throws — a resize failure must not cost us the image. */
export async function downscaleImage(
  body: Uint8Array,
  contentType: string,
): Promise<{ data: Uint8Array; mediaType: string }> {
  const fallback = { data: body, mediaType: contentType || "image/jpeg" }
  if (!/^image\//i.test(contentType) || /svg|gif/i.test(contentType)) return fallback
  try {
    if (sharpModule === undefined) {
      sharpModule = (await import("sharp").catch(() => null))?.default ?? null
      if (!sharpModule)
        console.warn("[caption] sharp unavailable — images go to the model full size")
    }
    if (!sharpModule) return fallback
    const sharp = sharpModule as (input: Uint8Array) => {
      resize: (o: object) => { jpeg: (o: object) => { toBuffer: () => Promise<Buffer> } }
    }
    const buf = await sharp(body)
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer()
    return { data: new Uint8Array(buf), mediaType: "image/jpeg" }
  } catch (e) {
    console.warn(`[caption] downscale failed: ${(e as Error)?.message ?? e}`)
    return fallback
  }
}
