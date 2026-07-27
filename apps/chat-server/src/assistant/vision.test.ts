// The assistant's vision path (PSN-104): view_image buffers real pixels, and the buffer is what
// gets appended to later steps — pixels can't ride back inside the tool result.

import Database from "better-sqlite3"
import { describe, expect, test, vi } from "vitest"
import { migrate, upsertMessages } from "../store.ts"
import { buildSystemPrompt, createAssistantTools, createImageBuffer } from "./loop.ts"

const AMS = "https://as-api.asm.skype.com/v1/objects/obj-1/views/imgo"
const PROXIED = `/api/chat/media?service=teams&url=${encodeURIComponent(AMS)}`

function seed() {
  const db = migrate(new Database(":memory:"))
  upsertMessages(db, "teams", "c1", [
    { id: "m1", ts: 1, senderName: "Alice", body: `<p>the error</p><img src="${PROXIED}">` },
  ])
  return db
}

const PIXELS = { data: new Uint8Array([1, 2, 3]), mediaType: "image/jpeg" }

describe("view_image", () => {
  test("is absent unless the model can see — a text-only model can't call it", () => {
    const db = seed()
    const tools = createAssistantTools(db, "teams", () => {})
    expect(Object.keys(tools)).not.toContain("view_image")
  })

  test("fetched pixels land in the buffer and become a user message for the next step", async () => {
    const db = seed()
    const buffer = createImageBuffer()
    const surfaced: string[] = []
    const tools = createAssistantTools(db, "teams", (c, m) => surfaced.push(`${c}:${m}`), {
      fetchImage: async () => PIXELS,
      buffer,
    })
    const out = await tools.view_image?.execute?.(
      { convId: "c1", msgId: "m1" },
      // biome-ignore lint/suspicious/noExplicitAny: the SDK's execute options, unused here
      {} as any,
    )
    expect(out).toMatchObject({ attached: true })
    // Citing what an image showed needs the message in the allow set.
    expect(surfaced).toEqual(["c1:m1"])

    const msg = buffer.message()
    expect(msg.role).toBe("user")
    expect(msg.content[0].text).toContain("[msg:c1:m1] image#1")
    expect(msg.content[1]).toEqual({ type: "file", ...PIXELS })

    // Asking twice for the same image doesn't duplicate it in the window.
    await tools.view_image?.execute?.({ convId: "c1", msgId: "m1", index: 1 }, {} as any)
    expect(buffer.size).toBe(1)
  })

  test("an unreachable image degrades to its transcription instead of erroring", async () => {
    const db = seed()
    const captionImage = vi.fn(async () => "ERR_CONNECTION_REFUSED")
    const tools = createAssistantTools(db, "teams", () => {}, {
      fetchImage: async () => null,
      captionImage,
      buffer: createImageBuffer(),
    })
    // biome-ignore lint/suspicious/noExplicitAny: the SDK's execute options, unused here
    const out = await tools.view_image?.execute?.({ convId: "c1", msgId: "m1" }, {} as any)
    expect(out).toMatchObject({ attached: false, caption: "ERR_CONNECTION_REFUSED" })
    expect(captionImage).toHaveBeenCalledOnce()
  })

  test("an empty buffer contributes no message (nothing to inject)", () => {
    expect(createImageBuffer().message()).toBeNull()
  })

  test("the prompt tells a blind model that transcriptions are all it gets", () => {
    expect(buildSystemPrompt({ vision: true })).toContain("Call view_image only when")
    const blind = buildSystemPrompt({})
    expect(blind).not.toContain("view_image")
    expect(blind).toContain("that text is all you can see")
  })
})
