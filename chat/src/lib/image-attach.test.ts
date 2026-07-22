import { describe, expect, it } from "vitest"
import { pickFile } from "./image-attach"

// Minimal DataTransferItem-like stub: what pickFile reads (getAsFile).
const item = (file: File | null) => ({ getAsFile: () => file })
const png = new File(["x"], "shot.png", { type: "image/png" })
const pdf = new File(["x"], "report.pdf", { type: "application/pdf" })

describe("pickFile", () => {
  it("returns the first File-backed item from a clipboard items list", () => {
    expect(pickFile([item(null), item(png)])).toBe(png)
  })

  it("picks a non-image file too (t124)", () => {
    expect(pickFile([item(null), item(pdf)])).toBe(pdf)
  })

  it("ignores text items with no backing File (a plain text paste)", () => {
    expect(pickFile([item(null), item(null)])).toBeNull()
  })

  it("returns null for an empty or missing list", () => {
    expect(pickFile([])).toBeNull()
    expect(pickFile(null)).toBeNull()
    expect(pickFile(undefined)).toBeNull()
  })

  it("skips an item whose getAsFile yields null and keeps looking", () => {
    expect(pickFile([item(null), item(pdf)])).toBe(pdf)
  })
})
