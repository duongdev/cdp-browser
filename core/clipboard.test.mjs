import { describe, expect, it } from "vitest"
import {
  buildClipboardPermissionsLegacy,
  buildClipboardPermissionsModern,
  selectPasteRoute,
} from "./clipboard.js"

describe("clipboard permissions", () => {
  describe("buildClipboardPermissionsModern", () => {
    it("returns modern permission names without origin", () => {
      const payload = buildClipboardPermissionsModern()
      expect(payload).toEqual({
        permissions: ["clipboardRead", "clipboardWrite"],
      })
    })

    it("includes origin when provided", () => {
      const payload = buildClipboardPermissionsModern("https://example.com")
      expect(payload).toEqual({
        origin: "https://example.com",
        permissions: ["clipboardRead", "clipboardWrite"],
      })
    })
  })

  describe("buildClipboardPermissionsLegacy", () => {
    it("returns legacy permission names without origin", () => {
      const payload = buildClipboardPermissionsLegacy()
      expect(payload).toEqual({
        permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
      })
    })

    it("includes origin when provided", () => {
      const payload = buildClipboardPermissionsLegacy("https://example.com")
      expect(payload).toEqual({
        origin: "https://example.com",
        permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
      })
    })
  })

  describe("selectPasteRoute", () => {
    it("returns insertText for plain inputs", () => {
      const result = selectPasteRoute({})
      expect(result.route).toBe("insertText")
      expect(result.reason).toContain("Plain input")
    })

    it("returns insertText when both flags are false", () => {
      const result = selectPasteRoute({ isContentEditable: false, isRichEditor: false })
      expect(result.route).toBe("insertText")
    })

    it("returns preseed when isContentEditable is true", () => {
      const result = selectPasteRoute({ isContentEditable: true })
      expect(result.route).toBe("preseed")
      expect(result.reason).toContain("Rich editor")
    })

    it("returns preseed when isRichEditor is true", () => {
      const result = selectPasteRoute({ isRichEditor: true })
      expect(result.route).toBe("preseed")
      expect(result.reason).toContain("Rich editor")
    })

    it("returns preseed when either flag is true", () => {
      const result = selectPasteRoute({ isContentEditable: true, isRichEditor: false })
      expect(result.route).toBe("preseed")
    })

    it("handles null descriptor gracefully", () => {
      const result = selectPasteRoute(null)
      expect(result.route).toBe("insertText")
    })

    it("handles undefined descriptor gracefully", () => {
      const result = selectPasteRoute(undefined)
      expect(result.route).toBe("insertText")
    })
  })
})
