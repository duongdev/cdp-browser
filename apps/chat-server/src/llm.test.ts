import { generateText, tool } from "ai"
import { MockLanguageModelV3 } from "ai/test"
import { describe, expect, test } from "vitest"
import { z } from "zod"
import { type LlmUnconfiguredError, parseModelList, readLlmConfig, resolveModel } from "./llm.ts"

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

describe("parseModelList (t177)", () => {
  test("id and id:label pairs, whitespace tolerated, default flagged", () => {
    const models = parseModelList({
      LLM_MODELS: " glm/glm-4.7 : GLM 4.7 , glm/glm-5.1,  ",
      LLM_MODEL: "glm/glm-5.1",
    })
    expect(models).toEqual([
      { id: "glm/glm-4.7", label: "GLM 4.7", default: false },
      { id: "glm/glm-5.1", label: "glm/glm-5.1", default: true },
    ])
  })

  test("empty LLM_MODELS falls back to LLM_MODEL; env default absent from list marks first", () => {
    expect(parseModelList({ LLM_MODEL: "m1" })).toEqual([{ id: "m1", label: "m1", default: true }])
    const models = parseModelList({ LLM_MODELS: "a,b", LLM_MODEL: "zz" })
    expect(models[0]).toEqual({ id: "a", label: "a", default: true })
  })

  test("nothing configured → empty; dupes collapse", () => {
    expect(parseModelList({})).toEqual([])
    expect(parseModelList({ LLM_MODELS: "a,a:Label A" })).toHaveLength(1)
  })
})
