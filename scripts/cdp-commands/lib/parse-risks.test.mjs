import { describe, expect, it } from "vitest"
import { parseOpenRisks, parseRisks } from "./parse-risks.mjs"

const SAMPLE = `# Risks

## CDP / Electron risks

### R-001 — Screencast frame drops on tab switch 🟡

body

### R-017 — CDP host unreachable during reconnect 🟡

### R-016 — Edge CDP API diverges from Chrome 🔴

body

### R-018 — Input forwarding breaks on OS update 🔴
`

describe("parseRisks", () => {
  it("parses id, title, status in document order", () => {
    const all = parseRisks(SAMPLE)
    expect(all.map((r) => r.id)).toEqual(["R-001", "R-017", "R-016", "R-018"])
    expect(all[2]).toEqual({
      id: "R-016",
      title: "Edge CDP API diverges from Chrome",
      status: "🔴",
    })
  })

  it("parseOpenRisks keeps only 🔴, order-independent of R-number", () => {
    expect(parseOpenRisks(SAMPLE).map((r) => r.id)).toEqual(["R-016", "R-018"])
  })

  it("returns [] when there are no risks", () => {
    expect(parseRisks("# Risks\n\nnothing here")).toEqual([])
  })
})
