import { describe, expect, it } from "vitest"
import { findUniquePath } from "./find-unique-path.mjs"

describe("findUniquePath", () => {
  it("returns the plain path when nothing collides", () => {
    expect(findUniquePath("docs/x", "foo", ".md", { exists: () => false })).toBe("docs/x/foo.md")
  })

  it("appends -2 on first collision", () => {
    const taken = new Set(["docs/x/foo.md"])
    expect(findUniquePath("docs/x", "foo", ".md", { exists: (p) => taken.has(p) })).toBe(
      "docs/x/foo-2.md",
    )
  })

  it("walks to the first free suffix", () => {
    const taken = new Set(["docs/x/foo.md", "docs/x/foo-2.md", "docs/x/foo-3.md"])
    expect(findUniquePath("docs/x", "foo", ".md", { exists: (p) => taken.has(p) })).toBe(
      "docs/x/foo-4.md",
    )
  })
})
