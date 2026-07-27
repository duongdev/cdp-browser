// LLM provider seam (t172, ADR-0021 decision 1). The AI SDK `LanguageModel` IS the provider
// abstraction — no interface of our own on top. `resolveModel` reads pure config (env by default)
// and returns a model via `@ai-sdk/openai-compatible`, first pointed at the user's 9router; a
// direct Anthropic/OpenAI provider later is a config change plus at most one import.
//
// No coding-plan endpoints are baked in (z.ai ToS — ADR-0021 context). Privacy note: a router's
// tiered fallback can route excerpts to free-tier providers; tier discipline for the pinned model
// is router config, the user's responsibility.

import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import type { LanguageModel } from "ai"

export interface LlmConfig {
  baseURL: string
  apiKey?: string
  model: string
}

/** Typed unconfigured error — assistant routes surface `{error: "llm-unconfigured"}` (same
 *  contract shape as ProviderError codes), never a crash. */
export class LlmUnconfiguredError extends Error {
  code = "llm-unconfigured" as const
  constructor() {
    super("LLM not configured: set LLM_BASE_URL and LLM_MODEL")
  }
}

/** Read `{baseURL, apiKey, model}` from env. Returns null when unset (caller throws typed). */
export function readLlmConfig(
  env: Record<string, string | undefined> = process.env,
): LlmConfig | null {
  const baseURL = (env.LLM_BASE_URL || "").trim()
  const model = (env.LLM_MODEL || "").trim()
  if (!baseURL || !model) return null
  return { baseURL, apiKey: (env.LLM_API_KEY || "").trim() || undefined, model }
}

/** Config → LanguageModel. `modelId` overrides the config's model (per-session pick, t177). */
export function resolveModel(config: LlmConfig | null, modelId?: string): LanguageModel {
  if (!config) throw new LlmUnconfiguredError()
  const provider = createOpenAICompatible({
    name: "llm",
    baseURL: config.baseURL,
    apiKey: config.apiKey ?? "unused",
  })
  return provider.chatModel(modelId || config.model)
}
