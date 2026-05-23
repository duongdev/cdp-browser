import { describe, expect, it } from "vitest"
import { parseTaskStatus } from "./parse-task-status.mjs"

describe("parseTaskStatus", () => {
  it("reads the Status header", () => {
    expect(parseTaskStatus("# 004\n\n- **Status:** in-progress\n")).toBe("in-progress")
  })

  it("normalises a parenthetical suffix to the first token", () => {
    expect(parseTaskStatus("- **Status:** ready (may need split)")).toBe("ready")
  })

  it("location wins — done/ overrides any header", () => {
    expect(parseTaskStatus("- **Status:** in-progress", { inDoneDir: true })).toBe("done")
  })

  it("returns null when there is no header", () => {
    expect(parseTaskStatus("# just a title\n")).toBeNull()
  })
})
