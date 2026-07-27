import { generateText, tool } from "ai"
import { MockLanguageModelV3 } from "ai/test"
import { describe, expect, test } from "vitest"
import { z } from "zod"
import {
  enrichModelLimits,
  type LlmUnconfiguredError,
  parseModelList,
  readLlmConfig,
  resolveModel,
} from "./llm.ts"

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

describe("enrichModelLimits (steering: exact context window)", () => {
  const cfg = { baseURL: "http://router/v1", apiKey: "k", model: "glm/glm-5.2" }
  const body = {
    data: [
      { id: "glm/glm-5.2", capabilities: { contextWindow: 200000, maxOutput: 128000 } },
      { id: "other", capabilities: { contextWindow: 8192 } },
      { id: "no-caps" },
    ],
  }
  const okFetch = (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch

  test("enriches only the curated models, leaves unknown ones untouched", async () => {
    const out = await enrichModelLimits(
      [
        { id: "glm/glm-5.2", label: "GLM 5.2", default: true },
        { id: "no-caps", label: "No caps", default: false },
      ],
      cfg,
      okFetch,
    )
    expect(out[0]).toMatchObject({ contextWindow: 200000, maxOutput: 128000 })
    expect(out[1].contextWindow).toBeUndefined()
  })

  test("reads the alternate router key shapes (context_length / top_provider)", async () => {
    const alt = {
      data: [
        { id: "glm/glm-4.7", context_length: 131072, max_output_tokens: 8192 },
        { id: "b", top_provider: { context_length: "65536" } },
      ],
    }
    const out = await enrichModelLimits(
      [
        { id: "glm/glm-4.7", label: "GLM 4.7", default: true },
        { id: "b", label: "B", default: false },
      ],
      cfg,
      (async () => new Response(JSON.stringify(alt), { status: 200 })) as typeof fetch,
    )
    expect(out[0]).toMatchObject({ contextWindow: 131072, maxOutput: 8192 })
    expect(out[1].contextWindow).toBe(65536)
  })

  test("degrades silently on a failed lookup / no config", async () => {
    const models = [{ id: "m", label: "m", default: true }]
    const bad = (async () => {
      throw new Error("network")
    }) as typeof fetch
    expect(await enrichModelLimits(models, cfg, bad)).toEqual(models)
    expect(await enrichModelLimits(models, null)).toEqual(models)
    const notOk = (async () => new Response("nope", { status: 500 })) as typeof fetch
    expect(await enrichModelLimits(models, cfg, notOk)).toEqual(models)
  })
})
