import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { addRisk } from "./risk.mjs"

const SEED = `# Risks

**Status legend:**
- 🔴 **Open**

---

### R-001 — first thing 🟡

context.

### R-016 — open thing 🔴

context.

### R-017 — newer thing 🟡

context.

---

_Last revisited: 2026-05-16_
`

describe("addRisk", () => {
  let file

  beforeEach(() => {
    file = join(mkdtempSync(join(tmpdir(), "cdp-risk-")), "risks.md")
    writeFileSync(file, SEED)
  })

  afterEach(() => {})

  it("picks max+1 order-independently (R-017 before R-016 → R-018)", () => {
    const { file: written, id } = addRisk("some new risk", { risksFile: file })
    expect(id).toBe("R-018")
    expect(written).toBe(file)
  })

  it("appends an open 🔴 block with the mitigation/trigger scaffold", () => {
    addRisk("some new risk", { risksFile: file })
    const out = readFileSync(file, "utf8")
    expect(out).toContain("### R-018 — some new risk 🔴")
    expect(out).toContain("_To be filled._")
    expect(out).toContain("**Mitigation:**\n- _TBD_")
    expect(out).toContain("**Trigger to escalate:** _TBD_")
  })

  it("preserves prior content verbatim", () => {
    addRisk("some new risk", { risksFile: file })
    const out = readFileSync(file, "utf8")
    expect(out.startsWith(SEED.replace(/\n+$/, "\n"))).toBe(true)
    expect(out).toContain("_Last revisited: 2026-05-16_")
  })

  it("rejects blank input", () => {
    expect(() => addRisk("", { risksFile: file })).toThrow()
    expect(() => addRisk("   ", { risksFile: file })).toThrow()
    expect(() => addRisk(undefined, { risksFile: file })).toThrow()
  })
})
