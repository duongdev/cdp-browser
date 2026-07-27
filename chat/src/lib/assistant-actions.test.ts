import { describe, expect, test } from "vitest"
import {
  actionItemsPrompt,
  catchUpPrompt,
  draftReplyPrompt,
  summarizePrompt,
} from "./assistant-actions"

describe("prompt seeds", () => {
  test("summarize embeds the conversation title", () => {
    expect(summarizePrompt("Deploy crew")).toContain('"Deploy crew"')
  })
  test("catch-up names the tool", () => {
    expect(catchUpPrompt()).toContain("get_unread_overview")
  })
  test("draft reply folds voice guidance in; empty voice adds none", () => {
    expect(draftReplyPrompt("ngắn gọn, thân thiện")).toContain("ngắn gọn, thân thiện")
    expect(draftReplyPrompt("")).not.toContain("Tone guidance")
    expect(draftReplyPrompt("  ")).not.toContain("Tone guidance")
    // A draft goes to a colleague — it must opt OUT of the terse style the assistant answers in.
    expect(draftReplyPrompt("")).toContain("normal complete sentences")
  })
  test("action items ask for honest none-found", () => {
    expect(actionItemsPrompt().toLowerCase()).toContain("none")
  })
})
