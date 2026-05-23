import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { addIdea } from "./idea.mjs"

const HEADER = `# Ideas backlog

Format: each entry is one line, prefixed with \`YYYY-MM-DD HH:MM\`. Newest at top.

---
`
const EXISTING = "2026-05-16 16:00 pipe CDP events to a system tray indicator"

function seed() {
  const dir = mkdtempSync(join(tmpdir(), "cdp-idea-"))
  writeFileSync(join(dir, "ideas.md"), `${HEADER}\n${EXISTING}\n`)
  return dir
}

describe("addIdea", () => {
  it("inserts the new entry at the top of the entry list", () => {
    const dir = seed()
    addIdea("a fresh idea", { baseDir: dir })
    const lines = readFileSync(join(dir, "ideas.md"), "utf8").split("\n")
    const sep = lines.indexOf("---")
    expect(lines[sep + 1]).toBe("")
    expect(lines[sep + 2]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} a fresh idea$/)
  })

  it("preserves pre-existing entries verbatim below the new one", () => {
    const dir = seed()
    addIdea("newer", { baseDir: dir })
    const content = readFileSync(join(dir, "ideas.md"), "utf8")
    expect(content).toContain(EXISTING)
    expect(content.indexOf("newer")).toBeLessThan(content.indexOf(EXISTING))
  })

  it("rejects blank input", () => {
    const dir = seed()
    expect(() => addIdea("   ", { baseDir: dir })).toThrow()
    expect(() => addIdea("", { baseDir: dir })).toThrow()
  })
})
