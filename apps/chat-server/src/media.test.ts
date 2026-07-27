// Inline-image extraction, the media store's caption cache, and the transcription worker (PSN-104).

import Database from "better-sqlite3"
import { beforeEach, describe, expect, test, vi } from "vitest"
import { createCaptioner, downscaleImage } from "./caption.ts"
import { amsUrlFromSrc, extractImages } from "./media-images.ts"
import { captionsForMessage, findByObjectId, listMessageImages, setCaption } from "./media-store.ts"
import { searchMessages } from "./search.ts"
import { migrate, upsertMessages } from "./store.ts"

const AMS = "https://as-api.asm.skype.com/v1/objects/0-wus-d1-abc/views/imgo"
const PROXIED = `/api/chat/media?service=teams&url=${encodeURIComponent(AMS)}`

describe("extractImages", () => {
  test("pulls proxied AMS images in document order, ignoring public-CDN media", () => {
    const body =
      `<p>look</p><img src="${PROXIED}" width="100">` +
      '<img src="https://statics.teams.cdn.office.net/emoji/smile.png">' +
      `<img src="${PROXIED.replace("abc", "def")}">`
    const imgs = extractImages(body)
    expect(imgs.map((i) => i.index)).toEqual([1, 2])
    expect(imgs[0]).toMatchObject({ url: AMS, objectId: "0-wus-d1-abc" })
    expect(imgs[1].objectId).toBe("0-wus-d1-def")
  })

  test("a bare (un-rewritten) AMS src still counts; anything else does not", () => {
    expect(extractImages(`<img src="${AMS}">`)).toHaveLength(1)
    expect(extractImages('<img src="https://evil.example/x.png">')).toEqual([])
    expect(extractImages("")).toEqual([])
  })

  test("amsUrlFromSrc unwraps the proxy path and rejects a foreign host", () => {
    expect(amsUrlFromSrc(PROXIED)).toBe(AMS)
    expect(amsUrlFromSrc(PROXIED.replace(/&/g, "&amp;"))).toBe(AMS)
    expect(amsUrlFromSrc("/api/chat/media?url=https%3A%2F%2Fevil.example%2Fa")).toBeNull()
  })
})

describe("ingest + caption → search", () => {
  let db: ReturnType<typeof migrate>
  beforeEach(() => {
    db = migrate(new Database(":memory:"))
  })

  test("an image message registers a pending row and becomes searchable once transcribed", () => {
    upsertMessages(db, "teams", "c1", [
      { id: "m1", ts: 1000, senderName: "Alice", body: `<p>see this</p><img src="${PROXIED}">` },
    ])
    const rows = listMessageImages(db, "teams", "c1", "m1")
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ objectId: "0-wus-d1-abc", status: "pending", caption: null })

    // The marker is what tells the model an image is there at all.
    const [hit] = searchMessages(db, { query: "see this" })
    expect(hit.snippet).toContain("[image#1]")
    expect(hit.images).toEqual([{ index: 1, status: "pending", caption: null }])

    // Nothing matches the screenshot's contents yet.
    expect(searchMessages(db, { query: "ERR_CONNECTION_REFUSED" })).toEqual([])

    setCaption(db, "teams", "0-wus-d1-abc", "ERR_CONNECTION_REFUSED at deploy step")
    // Re-index (what the worker does) and the text inside the image is findable.
    upsertMessages(db, "teams", "c1", [
      { id: "m1", ts: 1000, senderName: "Alice", body: `<p>see this</p><img src="${PROXIED}">` },
    ])
    expect(searchMessages(db, { query: "connection refused" }).map((h) => h.msgId)).toEqual(["m1"])
    expect(captionsForMessage(db, "teams", "c1", "m1")).toEqual([
      "ERR_CONNECTION_REFUSED at deploy step",
    ])
  })

  test("the same image forwarded elsewhere inherits its transcription — no second call", () => {
    upsertMessages(db, "teams", "c1", [{ id: "m1", ts: 1, body: `<img src="${PROXIED}">` }])
    setCaption(db, "teams", "0-wus-d1-abc", "a chart")
    upsertMessages(db, "teams", "c2", [{ id: "m2", ts: 2, body: `<img src="${PROXIED}">` }])
    const [row] = listMessageImages(db, "teams", "c2", "m2")
    expect(row).toMatchObject({ status: "done", caption: "a chart" })
    expect(findByObjectId(db, "teams", "0-wus-d1-abc")).toHaveLength(2)
  })
})

describe("captioner", () => {
  test("transcribes a pending image, stores it, and reports it once", async () => {
    const db = migrate(new Database(":memory:"))
    upsertMessages(db, "teams", "c1", [{ id: "m1", ts: 1, body: `<img src="${PROXIED}">` }])
    const onCaption = vi.fn()
    const captioner = createCaptioner({
      db,
      service: "teams",
      provider: {
        media: async () => ({ contentType: "image/png", body: new Uint8Array([1, 2, 3]) }),
      },
      // A stub "model": generateText is not exercised end-to-end here (that's llm-smoke's job);
      // this proves the queue → store → notify path.
      getModel: () => stubModel("transcribed text"),
      onCaption,
    })
    await captioner.tick()
    expect(listMessageImages(db, "teams", "c1", "m1")[0]).toMatchObject({
      status: "done",
      caption: "transcribed text",
    })
    expect(onCaption).toHaveBeenCalledTimes(1)
    // Second tick has nothing to do.
    onCaption.mockClear()
    await captioner.tick()
    expect(onCaption).not.toHaveBeenCalled()
  })

  test("a provider failure marks the row failed and never throws", async () => {
    const db = migrate(new Database(":memory:"))
    upsertMessages(db, "teams", "c1", [{ id: "m1", ts: 1, body: `<img src="${PROXIED}">` }])
    const captioner = createCaptioner({
      db,
      service: "teams",
      provider: {
        media: async () => {
          throw new Error("ams 401")
        },
      },
      getModel: () => stubModel("never"),
    })
    await expect(captioner.tick()).resolves.toBeUndefined()
    expect(listMessageImages(db, "teams", "c1", "m1")[0]).toMatchObject({
      status: "failed",
      caption: null,
    })
  })

  test("downscale degrades to the original bytes for a non-image or an undecodable blob", async () => {
    const body = new Uint8Array([9, 9, 9])
    expect(await downscaleImage(body, "application/pdf")).toEqual({
      data: body,
      mediaType: "application/pdf",
    })
    // Not a real PNG — sharp throws, and the original must still reach the model.
    expect(await downscaleImage(body, "image/png")).toEqual({ data: body, mediaType: "image/png" })
  })
})

// A minimal LanguageModelV3 that returns fixed text — enough for generateText's single call.
function stubModel(text: string) {
  return {
    specificationVersion: "v3" as const,
    provider: "stub",
    modelId: "stub",
    supportedUrls: {},
    async doGenerate() {
      return {
        content: [{ type: "text" as const, text }],
        finishReason: "stop" as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      }
    },
    async doStream() {
      throw new Error("not used")
    },
    // biome-ignore lint/suspicious/noExplicitAny: structural stand-in for the SDK's model type
  } as any
}
