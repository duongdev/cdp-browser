// Live smoke for the LLM seam (t172): streamed text + one tool call through the configured
// endpoint. Run with the router up:
//   LLM_BASE_URL=http://localhost:PORT/v1 LLM_API_KEY=... LLM_MODEL=glm/glm-4.7 \
//     node --experimental-transform-types apps/chat-server/src/llm-smoke.ts

import { stepCountIs, streamText, tool } from "ai"
import { z } from "zod"
import { readLlmConfig, resolveModel } from "./llm.ts"

const config = readLlmConfig()
if (!config) {
  console.error("set LLM_BASE_URL + LLM_MODEL (+ LLM_API_KEY)")
  process.exit(1)
}

const model = resolveModel(config)
console.info(`model: ${config.model} @ ${config.baseURL}`)

let toolCalled = false
const result = streamText({
  model,
  prompt: "What time is it? Use the clock tool, then tell me in one short sentence.",
  tools: {
    clock: tool({
      description: "Current time",
      inputSchema: z.object({ tz: z.string().optional() }),
      execute: async ({ tz }) => {
        toolCalled = true
        console.info(`\n[tool call] clock(${JSON.stringify({ tz })})`)
        return { now: new Date().toISOString() }
      },
    }),
  },
  stopWhen: stepCountIs(4),
})

for await (const chunk of result.textStream) process.stdout.write(chunk)
const usage = await result.usage
console.info(`\n\ntoolCalled=${toolCalled} usage=${JSON.stringify(usage)}`)
process.exit(toolCalled ? 0 : 2)
