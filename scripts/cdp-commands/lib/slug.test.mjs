import { describe, expect, it } from "vitest"
import { slug } from "./slug.mjs"

describe("slug", () => {
  it("kebab-cases plain text", () => {
    expect(slug("Add refresh token")).toBe("add-refresh-token")
  })

  it("strips special characters", () => {
    expect(slug("CDP: tabs & input (v0)!")).toBe("cdp-tabs-input-v0")
  })

  it("folds Vietnamese diacritics to ASCII", () => {
    expect(slug("Cải thiện độ trễ đẩy")).toBe("cai-thien-do-tre-day")
    expect(slug("Đặng")).toBe("dang")
  })

  it("caps length and trims a trailing dash", () => {
    const s = slug(`${"a".repeat(40)} ${"b".repeat(40)}`, { maxLen: 50 })
    expect(s.length).toBeLessThanOrEqual(50)
    expect(s.endsWith("-")).toBe(false)
  })

  it("never leads or trails with a dash", () => {
    expect(slug("  --hello--  ")).toBe("hello")
  })

  it("falls back to 'untitled' when nothing folds to ASCII", () => {
    expect(slug("日本語のタスク")).toBe("untitled")
    expect(slug("！！！")).toBe("untitled")
  })
})
