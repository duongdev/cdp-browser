import { describe, expect, it, vi } from "vitest"
// @ts-expect-error — CJS module, no types
import { atomicWriteFileSync } from "./atomic-write.js"

describe("atomicWriteFileSync", () => {
  it("writes to a temp sibling then renames onto the target", () => {
    const calls: string[] = []
    const writeFileSync = vi.fn((p: string) => calls.push(`write:${p}`))
    const renameSync = vi.fn((from: string, to: string) => calls.push(`rename:${from}->${to}`))

    atomicWriteFileSync("/data/settings.json", "{}", { writeFileSync, renameSync })

    expect(writeFileSync).toHaveBeenCalledWith("/data/settings.json.tmp", "{}")
    expect(renameSync).toHaveBeenCalledWith("/data/settings.json.tmp", "/data/settings.json")
    // write must happen before rename
    expect(calls).toEqual([
      "write:/data/settings.json.tmp",
      "rename:/data/settings.json.tmp->/data/settings.json",
    ])
  })

  it("does not rename (leaving the original intact) when the write throws", () => {
    const writeFileSync = vi.fn(() => {
      throw new Error("disk full")
    })
    const renameSync = vi.fn()

    expect(() => atomicWriteFileSync("/data/x.json", "{}", { writeFileSync, renameSync })).toThrow(
      "disk full",
    )
    expect(renameSync).not.toHaveBeenCalled()
  })
})
