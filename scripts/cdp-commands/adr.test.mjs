import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { scaffoldAdr } from "./adr.mjs"

const TEMPLATE = `# ADR-NNNN: <short title>

- **Status:** Proposed | Accepted | Superseded by ADR-NNNN | Rejected
- **Date:** YYYY-MM-DD

## Context

What is the situation forcing this decision?

## Decision

What did we decide?

## Consequences

What becomes easier and what becomes harder?

## Alternatives

What else was considered?
`

describe("scaffoldAdr", () => {
  /** @type {{adrDir: string, templatePath: string}} */
  let opts

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), "cdp-adr-"))
    const adrDir = join(root, "adr")
    mkdirSync(adrDir, { recursive: true })
    const templatePath = join(adrDir, "TEMPLATE.md")
    writeFileSync(templatePath, TEMPLATE)
    opts = { adrDir, templatePath }
  })

  afterEach(() => {
    opts = undefined
  })

  it("numbers from the max 4-digit prefix and fills header lines", () => {
    writeFileSync(join(opts.adrDir, "0003-x.md"), "x")
    writeFileSync(join(opts.adrDir, "0004-y.md"), "y")

    const path = scaffoldAdr("use websocket pooling", opts)

    expect(basename(path)).toBe("0005-use-websocket-pooling.md")
    const body = readFileSync(path, "utf8")
    expect(body).toMatch(/^# ADR-0005: use websocket pooling$/m)
    expect(body).toContain("- **Status:** Proposed")
    const iso = new Date()
    const p = (n) => String(n).padStart(2, "0")
    const expected = `${iso.getFullYear()}-${p(iso.getMonth() + 1)}-${p(iso.getDate())}`
    expect(body).toContain(`- **Date:** ${expected}`)
    expect(body).toContain("## Context")
  })

  it("starts at 0004 when existing max is 0003", () => {
    writeFileSync(join(opts.adrDir, "0003-existing.md"), "x")
    const path = scaffoldAdr("first new decision", opts)
    expect(basename(path)).toBe("0004-first-new-decision.md")
  })

  it("starts at 0001 when no ADRs exist", () => {
    const path = scaffoldAdr("first decision", opts)
    expect(basename(path)).toBe("0001-first-decision.md")
  })

  it("increments the number when a same-slug file exists", () => {
    writeFileSync(join(opts.adrDir, "0001-pick-x.md"), "taken")
    const path = scaffoldAdr("pick x", opts)
    expect(basename(path)).toBe("0002-pick-x.md")
  })

  it("rejects blank input", () => {
    expect(() => scaffoldAdr("  ", opts)).toThrow(/required/)
    expect(() => scaffoldAdr("", opts)).toThrow(/required/)
  })
})
