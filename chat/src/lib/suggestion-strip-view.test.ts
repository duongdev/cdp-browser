import { describe, expect, test } from "vitest"
import type { ReplySuggestionBatch } from "./chat-client"
import { isStale, stripMode } from "./suggestion-strip-view"

function batch(over: Partial<ReplySuggestionBatch> = {}): ReplySuggestionBatch {
  return {
    id: 1,
    convId: "c1",
    forMsgId: "m1",
    producer: "hermes",
    createdAt: 1,
    status: "open",
    texts: ["a", "b"],
    chosenIdx: null,
    chosenAt: null,
    sentMsgId: null,
    sentText: null,
    sentAt: null,
    ...over,
  }
}

const base = { batch: null, pending: false, error: null, latestMsgId: null }

describe("isStale", () => {
  test("stale once a newer message arrives", () => {
    expect(isStale(batch({ forMsgId: "m1" }), "m2")).toBe(true)
  })

  test("fresh while it still answers the newest message", () => {
    expect(isStale(batch({ forMsgId: "m1" }), "m1")).toBe(false)
  })

  test("a manual generate is never stale — it answers the thread, not a message", () => {
    expect(isStale(batch({ forMsgId: null }), "m9")).toBe(false)
  })

  test("no batch and no thread tail are not stale", () => {
    expect(isStale(null, "m1")).toBe(false)
    expect(isStale(batch(), null)).toBe(false)
  })
})

describe("stripMode", () => {
  test("idle with nothing happening", () => {
    expect(stripMode(base)).toEqual({ kind: "idle" })
  })

  test("busy while a request is in flight", () => {
    expect(stripMode({ ...base, pending: true })).toEqual({ kind: "busy" })
  })

  test("error when a request failed", () => {
    expect(stripMode({ ...base, error: "No producer answered." })).toEqual({
      kind: "error",
      message: "No producer answered.",
    })
  })

  test("an error outranks the spinner — a finished failure is not still working", () => {
    expect(stripMode({ ...base, pending: true, error: "boom" }).kind).toBe("error")
  })

  test("renders the batch with its texts and choice", () => {
    expect(stripMode({ ...base, batch: batch({ chosenIdx: 1 }), latestMsgId: "m1" })).toEqual({
      kind: "batch",
      texts: ["a", "b"],
      chosenIdx: 1,
      stale: false,
      busy: false,
    })
  })

  test("an existing batch survives a regenerate — losing it would cost what he had", () => {
    const m = stripMode({ ...base, batch: batch(), pending: true })
    expect(m).toMatchObject({ kind: "batch", busy: true })
  })

  test("a regenerate over an existing batch still reports busy — otherwise the click looks dead", () => {
    expect(stripMode({ ...base, batch: batch(), pending: true })).toMatchObject({ busy: true })
    expect(stripMode({ ...base, batch: batch(), pending: false })).toMatchObject({ busy: false })
  })

  test("an existing batch survives an error too", () => {
    const m = stripMode({ ...base, batch: batch(), error: "timed out" })
    expect(m.kind).toBe("batch")
  })

  test("an empty batch is not a batch — it falls through to idle", () => {
    expect(stripMode({ ...base, batch: batch({ texts: [] }) })).toEqual({ kind: "idle" })
  })

  test("carries the stale flag through", () => {
    const m = stripMode({ ...base, batch: batch({ forMsgId: "m1" }), latestMsgId: "m5" })
    expect(m).toMatchObject({ kind: "batch", stale: true })
  })
})
