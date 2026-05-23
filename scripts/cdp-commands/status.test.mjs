import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { buildStatus } from "./status.mjs"

const RISKS = `# Risks

**Status legend:** 🔴 open, 🟡 mitigated

### R-001 — Screencast drops on tab switch 🔴

### R-017 — CDP host unreachable 🔴

### R-005 — Edge API divergence 🟡
`

/** Build a fixture repo tree. */
function seed({ depFourteen = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "cdp-status-"))
  const memories = join(root, "docs", "memories")
  const tasks = join(root, "docs", "tasks")
  const done = join(tasks, "done")
  mkdirSync(memories, { recursive: true })
  mkdirSync(done, { recursive: true })

  writeFileSync(join(memories, "risks.md"), RISKS)

  writeFileSync(
    join(tasks, "014-a.md"),
    "# 014 — Adaptive viewport polish\n\n- **Status:** in-progress\n- **Depends on:** none\n",
  )
  writeFileSync(
    join(tasks, "016-b.md"),
    "# 016 — Input forwarding IME\n\n- **Status:** ready\n- **Depends on:** none\n",
  )
  writeFileSync(
    join(tasks, "099-c.md"),
    "# 099 — Blocked task\n\n- **Status:** ready\n- **Depends on:** 014\n",
  )
  writeFileSync(
    join(done, "008-d.md"),
    "# 008 — Notification side-channel\n\n- **Status:** done\n- **Depends on:** none\n",
  )
  if (depFourteen) {
    renameSync(join(tasks, "014-a.md"), join(done, "014-a.md"))
  }
  return root
}

describe("buildStatus", () => {
  it("lists only the in-progress task (014)", () => {
    const out = buildStatus({ root: seed() })
    const block = out.split("In progress:\n")[1].split("\n\n")[0]
    expect(block).toBe("  - 014 — Adaptive viewport polish")
  })

  it("next-ready includes 016 but excludes 099 (dep 014 not done)", () => {
    const out = buildStatus({ root: seed() })
    expect(out).toMatch(/Next ready:\n {2}- 016 — Input forwarding IME/)
    expect(out).not.toContain("099 — Blocked task")
  })

  it("next-ready includes 099 once 014 is in done/", () => {
    const out = buildStatus({ root: seed({ depFourteen: true }) })
    expect(out).toContain("099 — Blocked task")
  })

  it("top open risks are the two 🔴 in document order", () => {
    const out = buildStatus({ root: seed() })
    const risks = out.split("Top open risks:\n")[1].split("\n\n")[0].split("\n")
    expect(risks[0]).toBe("  - R-001 — Screencast drops on tab switch")
    expect(risks[1]).toBe("  - R-017 — CDP host unreachable")
    expect(out).not.toContain("R-005")
  })

  it("shows (none) when no tasks are in-progress", () => {
    const out = buildStatus({ root: seed({ depFourteen: true }) })
    // 014 moved to done, so in-progress is empty
    expect(out).toContain("  - (none)")
  })
})
