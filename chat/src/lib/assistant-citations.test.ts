import { describe, expect, test } from "vitest"
import {
  citationChipLabel,
  citationKey,
  collectCitationMeta,
  extractCitations,
} from "./assistant-citations"

describe("extractCitations", () => {
  test("strips markers, collects citations in order", () => {
    const r = extractCitations("Bob said done [msg:c1:m2] and later [msg:c2:m9].")
    expect(r.text).toBe("Bob said done and later .")
    expect(r.citations).toEqual([
      { convId: "c1", msgId: "m2" },
      { convId: "c2", msgId: "m9" },
    ])
  })

  test("Teams conv ids with colons split on last colon", () => {
    const r = extractCitations("[msg:19:a_b@unq.gbl.spaces:1721990000000]")
    expect(r.citations).toEqual([{ convId: "19:a_b@unq.gbl.spaces", msgId: "1721990000000" }])
  })

  test("dedupes, malformed degrades to removal", () => {
    const r = extractCitations("[msg:c1:m1] [msg:c1:m1] [msg:broken]")
    expect(r.citations).toHaveLength(1)
    expect(r.text.trim()).toBe("")
  })

  test("no markers → text unchanged", () => {
    expect(extractCitations("plain **markdown**").text).toBe("plain **markdown**")
    expect(extractCitations("").citations).toEqual([])
  })
})

describe("collectCitationMeta", () => {
  const parts = [
    { type: "text", text: "ignored" },
    {
      type: "tool-search_messages",
      output: [
        { convId: "c1", msgId: "m1", sender: "Haiyang", ts: 5, snippet: "merged it directly" },
        { convId: "c1", msgId: "m2", sender: "Lego", ts: 6, snippet: "you approved it earlier" },
      ],
    },
    {
      type: "dynamic-tool",
      // A later window re-reads m1 with the full text — the first (search) row must win.
      output: {
        rows: [{ convId: "c1", msgId: "m1", sender: "Haiyang", ts: 5, text: "full body" }],
      },
    },
  ]

  test("indexes every surfaced row by conv+msg", () => {
    const meta = collectCitationMeta(parts)
    expect(meta.get(citationKey({ convId: "c1", msgId: "m1" }))).toEqual({
      sender: "Haiyang",
      ts: 5,
      text: "merged it directly",
    })
    expect(meta.get(citationKey({ convId: "c1", msgId: "m2" }))?.sender).toBe("Lego")
  })

  test("ignores non-tool parts and malformed rows", () => {
    expect(collectCitationMeta([{ type: "text", text: "x" }]).size).toBe(0)
    expect(collectCitationMeta([{ type: "tool-x", output: { convId: 1, msgId: 2 } }]).size).toBe(0)
    expect(collectCitationMeta([]).size).toBe(0)
  })
})

describe("citationChipLabel", () => {
  test("prefers sender + what they said", () => {
    expect(citationChipLabel({ sender: "Haiyang", text: "merged  it" }, "Team")).toBe(
      "Haiyang: merged it",
    )
  })
  test("degrades to sender, then the conversation name", () => {
    expect(citationChipLabel({ sender: "Haiyang" }, "Team")).toBe("Haiyang")
    expect(citationChipLabel(undefined, "Team")).toBe("Team")
    expect(citationChipLabel({ text: "  " }, "Team")).toBe("Team")
  })
})
