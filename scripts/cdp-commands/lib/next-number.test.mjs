import { describe, expect, it } from "vitest"
import { nextNumber } from "./next-number.mjs"

const TASK = /^(\d{3})-/
const ADR = /^(\d{4})-/
const RISK = /R-(\d+)/

describe("nextNumber", () => {
  it("increments the max 3-digit task prefix", () => {
    expect(nextNumber(["001-a.md", "014-b.md", "026-c.md"], { pattern: TASK, pad: 3 })).toBe("027")
  })

  it("is order-independent (R-017 before R-016)", () => {
    expect(
      nextNumber(["### R-017 — x 🟡", "### R-016 — y 🔴"], {
        pattern: RISK,
        pad: 3,
      }),
    ).toBe("018")
  })

  it("ignores gaps — uses max not count", () => {
    expect(nextNumber(["001-a.md", "009-b.md"], { pattern: TASK, pad: 3 })).toBe("010")
  })

  it("starts at padded 1 when nothing matches", () => {
    expect(nextNumber([], { pattern: ADR, pad: 4 })).toBe("0001")
    expect(nextNumber(["README.md"], { pattern: ADR, pad: 4 })).toBe("0001")
  })

  it("pads 4-digit ADR numbers", () => {
    expect(nextNumber(["0009-x.md", "0010-y.md"], { pattern: ADR, pad: 4 })).toBe("0011")
  })
})
