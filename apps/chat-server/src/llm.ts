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

export interface ModelOption {
  id: string
  label: string
  default: boolean
  /** The model's real context window in tokens, when the provider reports one (see
   *  `enrichModelLimits`). Absent → the client falls back to a conservative default. */
  contextWindow?: number
  maxOutput?: number
}

/** Ask the provider for the CURATED models' real limits. This is not model discovery (ADR-0021
 *  still rejects offering the raw `/v1/models` dump) — the offered set is env-curated; this only
 *  looks up `capabilities.contextWindow` / `maxOutput` for models we already offer, so the context
 *  meter shows the model's actual budget instead of a guess. Failure degrades silently. */
export async function enrichModelLimits(
  models: ModelOption[],
  config: LlmConfig | null,
  fetchImpl: typeof fetch = fetch,
): Promise<ModelOption[]> {
  if (!config || models.length === 0) return models
  try {
    const res = await fetchImpl(`${config.baseURL.replace(/\/$/, "")}/models`, {
      headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return models
    const body = (await res.json()) as { data?: unknown }
    const byId = new Map<string, { contextWindow?: number; maxOutput?: number }>()
    for (const row of Array.isArray(body.data) ? body.data : []) {
      const m = row as Record<string, unknown>
      if (typeof m?.id !== "string") continue
      const caps = (m.capabilities ?? {}) as Record<string, unknown>
      const top = (m.top_provider ?? {}) as Record<string, unknown>
      // The window is reported under a different key per router flavour — a model whose row uses
      // a shape we don't read falls back to the compaction budget and reads as "40K again".
      const contextWindow = firstNumber(
        caps.contextWindow,
        caps.context_window,
        caps.context_length,
        m.context_window,
        m.context_length,
        m.max_context_length,
        top.context_length,
      )
      const maxOutput = firstNumber(
        caps.maxOutput,
        caps.max_output,
        caps.max_output_tokens,
        m.max_output_tokens,
        top.max_completion_tokens,
      )
      if (contextWindow || maxOutput) byId.set(m.id, { contextWindow, maxOutput })
    }
    return models.map((m) => {
      const hit = byId.get(m.id)
      return hit?.contextWindow || hit?.maxOutput ? { ...m, ...hit } : m
    })
  } catch {
    return models
  }
}

function firstNumber(...vals: unknown[]): number | undefined {
  for (const v of vals) {
    const n = typeof v === "string" ? Number(v) : v
    if (typeof n === "number" && Number.isFinite(n) && n > 0) return n
  }
  return undefined
}

/** Curated model list (t177) from `LLM_MODELS` — comma-separated `id[:label]` pairs (a model id
 *  never contains ':'; everything after the first colon is the label). Falls back to the single
 *  `LLM_MODEL`. NEVER the raw router /v1/models dump. Empty when nothing is configured. */
export function parseModelList(
  env: Record<string, string | undefined> = process.env,
): ModelOption[] {
  const def = (env.LLM_MODEL || "").trim()
  const out: ModelOption[] = []
  for (const part of (env.LLM_MODELS || "").split(",")) {
    const t = part.trim()
    if (!t) continue
    const i = t.indexOf(":")
    const id = (i === -1 ? t : t.slice(0, i)).trim()
    const label = i === -1 ? id : t.slice(i + 1).trim() || id
    if (id && !out.some((m) => m.id === id)) out.push({ id, label, default: false })
  }
  if (out.length === 0 && def) out.push({ id: def, label: def, default: false })
  const defIdx = out.findIndex((m) => m.id === def)
  const mark = defIdx === -1 ? 0 : defIdx
  if (out[mark]) out[mark] = { ...out[mark], default: true }
  return out
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
