import { generateText, tool } from "ai"
import { MockLanguageModelV3 } from "ai/test"
import { describe, expect, test } from "vitest"
import { z } from "zod"
import { type LlmUnconfiguredError, readLlmConfig, resolveModel } from "./llm.ts"

describe("readLlmConfig", () => {
  test("parses env", () => {
    expect(
      readLlmConfig({
        LLM_BASE_URL: "http://x:8000/v1",
        LLM_API_KEY: "k",
        LLM_MODEL: "glm/glm-4.7",
      }),
    ).toEqual({ baseURL: "http://x:8000/v1", apiKey: "k", model: "glm/glm-4.7" })
  })
  test("missing baseURL or model → null; apiKey optional", () => {
    expect(readLlmConfig({ LLM_MODEL: "m" })).toBeNull()
    expect(readLlmConfig({ LLM_BASE_URL: "http://x" })).toBeNull()
    expect(readLlmConfig({})).toBeNull()
    expect(readLlmConfig({ LLM_BASE_URL: "http://x", LLM_MODEL: "m" })?.apiKey).toBeUndefined()
  })
  test("whitespace-only counts as unset", () => {
    expect(readLlmConfig({ LLM_BASE_URL: "  ", LLM_MODEL: "m" })).toBeNull()
  })
})

describe("resolveModel", () => {
  test("null config throws typed llm-unconfigured", () => {
    try {
      resolveModel(null)
      expect.unreachable()
    } catch (e) {
      expect((e as LlmUnconfiguredError).code).toBe("llm-unconfigured")
    }
  })
  test("returns a model with the configured id; modelId overrides", () => {
    const cfg = { baseURL: "http://x/v1", model: "glm/glm-4.7" }
    const m = resolveModel(cfg) as { modelId: string }
    expect(m.modelId).toBe("glm/glm-4.7")
    const o = resolveModel(cfg, "glm/glm-5.1") as { modelId: string }
    expect(o.modelId).toBe("glm/glm-5.1")
  })
})

describe("mock LanguageModel round-trip (the t173+ test pattern)", () => {
  test("tool call round-trips through generateText", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => ({
        finishReason: { unified: "tool-calls", raw: undefined },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 5, text: 5, reasoning: undefined },
          raw: undefined,
        },
        content: [
          {
            type: "tool-call" as const,
            toolCallId: "call-1",
            toolName: "echo",
            input: JSON.stringify({ text: "xin chào" }),
          },
        ],
        warnings: [],
      }),
    })
    const calls: string[] = []
    await generateText({
      model,
      prompt: "echo something",
      tools: {
        echo: tool({
          inputSchema: z.object({ text: z.string() }),
          execute: async ({ text }) => {
            calls.push(text)
            return { echoed: text }
          },
        }),
      },
    })
    expect(calls).toEqual(["xin chào"])
  })
})
