import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { scaffoldTask } from "./new-task.mjs"

const TEMPLATE = `# NNN — <Short imperative title, lowercase>

- **Status:** draft | ready | in-progress | done

## Goal

One paragraph.

## Acceptance criteria

- [ ] …

## Out of scope

- …
`

describe("scaffoldTask", () => {
  /** @type {{tasksDir: string, doneDir: string, templatePath: string}} */
  let opts

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), "cdp-task-"))
    const tasksDir = join(root, "tasks")
    const doneDir = join(tasksDir, "done")
    mkdirSync(doneDir, { recursive: true })
    const templatePath = join(tasksDir, "TEMPLATE.md")
    writeFileSync(templatePath, TEMPLATE)
    opts = { tasksDir, doneDir, templatePath }
  })

  afterEach(() => {
    opts = undefined
  })

  it("numbers from the max prefix across tasks/ and done/", () => {
    writeFileSync(join(opts.tasksDir, "014-x.md"), "x")
    writeFileSync(join(opts.doneDir, "024-y.md"), "y")
    writeFileSync(join(opts.doneDir, "026-z.md"), "z")

    const path = scaffoldTask("fix viewport coordinate mapping", opts)

    expect(basename(path)).toBe("027-fix-viewport-coordinate-mapping.md")
    const body = readFileSync(path, "utf8")
    expect(body).toMatch(/^# 027 — fix viewport coordinate mapping$/m)
    expect(body).toContain("- **Status:** draft | ready | in-progress | done")
    expect(body).toContain("## Goal")
  })

  it("starts at 001 when no tasks exist", () => {
    const path = scaffoldTask("first task", opts)
    expect(basename(path)).toBe("001-first-task.md")
  })

  it("folds Vietnamese diacritics in the slug", () => {
    const path = scaffoldTask("Thêm trang đăng nhập", opts)
    expect(basename(path)).toBe("001-them-trang-dang-nhap.md")
  })

  it("appends -2 on filename collision", () => {
    writeFileSync(join(opts.tasksDir, "001-do-it.md"), "taken")
    const path = scaffoldTask("do it", opts)
    expect(basename(path)).toBe("002-do-it.md")
  })

  it("rejects blank input", () => {
    expect(() => scaffoldTask("   ", opts)).toThrow(/required/)
    expect(() => scaffoldTask("", opts)).toThrow(/required/)
  })
})
