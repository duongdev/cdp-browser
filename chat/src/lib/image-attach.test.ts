import { describe, expect, it } from "vitest"
import { pickImageFile } from "./image-attach"

// Minimal DataTransferItem-like stub: what pickImageFile reads (type + getAsFile).
const item = (type: string, file: File | null) => ({ type, getAsFile: () => file })
const png = new File(["x"], "shot.png", { type: "image/png" })

describe("pickImageFile", () => {
  it("returns the first image File from a clipboard items list", () => {
    const items = [item("text/plain", null), item("image/png", png)]
    expect(pickImageFile(items)).toBe(png)
  })

  it("ignores non-image items (a plain text paste)", () => {
    expect(pickImageFile([item("text/plain", null), item("text/html", null)])).toBeNull()
  })

  it("returns null for an empty or missing list", () => {
    expect(pickImageFile([])).toBeNull()
    expect(pickImageFile(null)).toBeNull()
    expect(pickImageFile(undefined)).toBeNull()
  })

  it("skips an image item whose getAsFile yields null and keeps looking", () => {
    const items = [item("image/gif", null), item("image/png", png)]
    expect(pickImageFile(items)).toBe(png)
  })
})
