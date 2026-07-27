import { describe, expect, test } from "vitest"
import { contextBudgetFor } from "../components/ai/assistant-panel"

describe("contextBudgetFor", () => {
  test("uses the model's real context window when the provider reports one", () => {
    expect(
      contextBudgetFor({
        id: "glm/glm-5.2",
        label: "GLM 5.2",
        default: true,
        contextWindow: 200_000,
      }),
    ).toBe(200_000)
  })
  test("falls back to the server's compaction budget when unknown", () => {
    expect(contextBudgetFor({ id: "m", label: "m", default: true })).toBe(40_000)
    expect(contextBudgetFor(undefined)).toBe(40_000)
  })
  test("ignores a nonsense window", () => {
    expect(contextBudgetFor({ id: "m", label: "m", default: true, contextWindow: 0 })).toBe(40_000)
  })
})
