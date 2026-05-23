import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { addLearning } from "./learn.mjs"

const HEADER = `# Learnings

Format: each entry is one paragraph, prefixed with \`YYYY-MM-DD\`. Newest at top.

---
`
const EXISTING = "2026-05-15 — Edge 148 allows multiple concurrent CDP clients per target."

function seed() {
  const dir = mkdtempSync(join(tmpdir(), "cdp-learn-"))
  writeFileSync(join(dir, "learnings.md"), `${HEADER}\n${EXISTING}\n\n---\n`)
  return dir
}

describe("addLearning", () => {
  it("inserts the new entry at the top of the entry list", () => {
    const dir = seed()
    addLearning("a hard-won lesson", { baseDir: dir })
    const lines = readFileSync(join(dir, "learnings.md"), "utf8").split("\n")
    const sep = lines.indexOf("---")
    expect(lines[sep + 1]).toBe("")
    expect(lines[sep + 2]).toMatch(/^\d{4}-\d{2}-\d{2} — a hard-won lesson$/)
    expect(lines[sep + 3]).toBe("")
    expect(lines[sep + 4]).toBe("---")
  })

  it("preserves pre-existing entries verbatim below the new one", () => {
    const dir = seed()
    addLearning("newer learning", { baseDir: dir })
    const content = readFileSync(join(dir, "learnings.md"), "utf8")
    expect(content).toContain(EXISTING)
    expect(content.indexOf("newer learning")).toBeLessThan(content.indexOf(EXISTING))
  })

  it("rejects blank input", () => {
    const dir = seed()
    expect(() => addLearning("   ", { baseDir: dir })).toThrow()
    expect(() => addLearning("", { baseDir: dir })).toThrow()
  })
})
