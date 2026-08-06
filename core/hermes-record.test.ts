import { describe, expect, it, vi } from "vitest"
// @ts-expect-error -- shared CJS core, no types (ADR-0008)
import {
  assistantMessageFrom,
  modelChangeMessage,
  recordMessage,
  userMessageFrom,
} from "./hermes-record.js"

/**
 * A Hermes-proxied turn never touches chat-server's turn route, so nothing persisted the
 * exchange, named the session or compacted it. Measured on preview before this existed: two
 * turns left 0 rows and title=null — the panel loads its thread from chat-server, so a reload
 * showed an empty conversation while Hermes still held the history.
 *
 * These tests pin the parts that decide whether the user's thread survives a reload.
 */

const BFF = "http://chat-server:7788"
let seq = 0
const makeId = () => `id-${++seq}`

function okFetch() {
  return vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }))
}

describe("recordMessage", () => {
  it("posts the message to the session's record route", async () => {
    const fetchImpl = okFetch()
    const ok = await recordMessage({
      bffUrl: BFF,
      sessionId: "s1",
      message: { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
      fetchImpl,
    })

    expect(ok).toBe(true)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe(`${BFF}/api/chat/assistant/sessions/s1/messages`)
    expect(init.method).toBe("POST")
    expect(JSON.parse(init.body).message.id).toBe("m1")
  })

  it("encodes the session id into the path", async () => {
    // An id is interpolated straight into a URL. Left raw, a `/` inside one would address a
    // different route entirely and the write would land somewhere unrelated (or 404 silently).
    const fetchImpl = okFetch()
    await recordMessage({
      bffUrl: BFF,
      sessionId: "a/b?c",
      message: { id: "m", role: "user", parts: [] },
      fetchImpl,
    })
    const url = new URL(fetchImpl.mock.calls[0][0])
    expect(url.pathname).toBe("/api/chat/assistant/sessions/a%2Fb%3Fc/messages")
    expect(url.search).toBe("")
  })

  it("only sets maintain when asked", async () => {
    // `maintain` triggers title generation + compaction. Firing it on the opening user write
    // would name the session from half an exchange.
    const fetchImpl = okFetch()
    await recordMessage({
      bffUrl: BFF,
      sessionId: "s1",
      message: { id: "m", role: "user", parts: [] },
      fetchImpl,
    })
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).maintain).toBe(false)

    await recordMessage({
      bffUrl: BFF,
      sessionId: "s1",
      message: { id: "m2", role: "assistant", parts: [] },
      maintain: true,
      fetchImpl,
    })
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body).maintain).toBe(true)
  })

  it("reports failure without throwing", async () => {
    // Recording runs after the answer already streamed. Throwing here would turn a bookkeeping
    // failure into a broken turn the user already paid for.
    const errors: string[] = []
    const bad = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }))
    const ok = await recordMessage(
      {
        bffUrl: BFF,
        sessionId: "s1",
        message: { id: "m", role: "user", parts: [] },
        fetchImpl: bad,
      },
      (line: string) => errors.push(line),
    )
    expect(ok).toBe(false)
    expect(errors).toHaveLength(1)
  })

  it("survives a network throw", async () => {
    const errors: string[] = []
    const boom = vi.fn(async () => {
      throw new Error("ECONNREFUSED")
    })
    const ok = await recordMessage(
      {
        bffUrl: BFF,
        sessionId: "s1",
        message: { id: "m", role: "assistant", parts: [] },
        fetchImpl: boom,
      },
      (line: string) => errors.push(line),
    )
    expect(ok).toBe(false)
    expect(errors[0]).toContain("ECONNREFUSED")
  })
})

describe("userMessageFrom", () => {
  it("reuses the id the AI SDK already assigned", () => {
    // appendMessage dedups on message id. A fresh id per attempt would stack duplicates of the
    // same question in the thread every time a turn is retried.
    const body = {
      messages: [
        { id: "u-old", role: "user", parts: [{ type: "text", text: "first" }] },
        { id: "a-1", role: "assistant", parts: [{ type: "text", text: "reply" }] },
        { id: "u-new", role: "user", parts: [{ type: "text", text: "second" }] },
      ],
    }
    expect(userMessageFrom(body, "second", makeId).id).toBe("u-new")
  })

  it("generates an id when the body has none", () => {
    const msg = userMessageFrom({ message: "hello" }, "hello", makeId)
    expect(msg.id).toBeTruthy()
    expect(msg.role).toBe("user")
    expect(msg.parts).toEqual([{ type: "text", text: "hello" }])
  })

  it("takes the last USER message, not the last message", () => {
    // A retry can leave an assistant message as the tail. Keying off it would attach the
    // question's row to the wrong id and overwrite the reply.
    const body = {
      messages: [
        { id: "u-1", role: "user", parts: [{ type: "text", text: "q" }] },
        { id: "a-1", role: "assistant", parts: [{ type: "text", text: "a" }] },
      ],
    }
    expect(userMessageFrom(body, "q", makeId).id).toBe("u-1")
  })
})

describe("assistantMessageFrom", () => {
  it("records the streamed text", () => {
    const msg = assistantMessageFrom("the answer", {}, makeId)
    expect(msg.role).toBe("assistant")
    expect(msg.parts[0].text).toBe("the answer")
    expect(msg.metadata).toBeUndefined()
  })

  it("flags an interrupted turn and still writes a row", () => {
    // Option B: a stopped turn must remain visible. An unrecorded partial is indistinguishable
    // from a turn that never ran, which is the silent state this change exists to remove.
    const msg = assistantMessageFrom("", { interrupted: true }, makeId)
    expect(msg.metadata.interrupted).toBe(true)
    expect(msg.parts[0].text).toBeTruthy()
  })

  it("keeps a partial answer when interrupted", () => {
    const msg = assistantMessageFrom("half an ans", { interrupted: true }, makeId)
    expect(msg.parts[0].text).toBe("half an ans")
    expect(msg.metadata.interrupted).toBe(true)
  })

  it("clips an oversized answer instead of dropping it", () => {
    // The route rejects oversized bodies. Sending one unclipped would lose the whole answer
    // to a 413 rather than storing what fits.
    const huge = "x".repeat(300_000)
    const msg = assistantMessageFrom(huge, {}, makeId)
    expect(msg.parts[0].text.length).toBe(256_000)
  })

  it("records which model produced the answer", () => {
    const msg = assistantMessageFrom("hi", { model: "glm/glm-5.1" }, makeId)
    expect(msg.metadata.model).toBe("glm/glm-5.1")
  })
})

describe("modelChangeMessage", () => {
  it("is a system row identified by metadata, not by its text", () => {
    // The renderer keys off metadata.kind. If it matched on text, a user could type the same
    // sentence and forge a marker row.
    const msg = modelChangeMessage("fwd-sonnet", "glm/glm-5.1", makeId)
    expect(msg.role).toBe("system")
    expect(msg.metadata.kind).toBe("model-change")
    expect(msg.metadata.from).toBe("fwd-sonnet")
    expect(msg.metadata.to).toBe("glm/glm-5.1")
    expect(msg.parts[0].text).toContain("glm/glm-5.1")
  })

  it("reports a first lock as coming from nothing", () => {
    const msg = modelChangeMessage(null, "fwd-sonnet", makeId)
    expect(msg.metadata.from).toBeNull()
  })
})
