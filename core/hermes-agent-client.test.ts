import { describe, expect, it, vi } from "vitest"
// @ts-expect-error - CJS shared-core module without types
import { createHermesClient, extractUserText } from "./hermes-agent-client.js"

const BASE = "http://hermes.test:8642"
const KEY = "test-key-123"

/** Minimal AI SDK v7 `useChat` request body: the full message array, every turn. */
function uiBody(texts: string[], extra: Record<string, unknown> = {}) {
  return {
    messages: texts.map((t, i) => ({
      id: `m${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      parts: [{ type: "text", text: t }],
    })),
    ...extra,
  }
}

/** A fetch double that records calls and replays queued responses. */
function fakeFetch(responses: unknown[]) {
  const calls: { url: string; init: RequestInit }[] = []
  const impl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const r = responses.shift()
    if (r instanceof Error) throw r
    return r as Response
  })
  return { impl, calls }
}

function jsonRes(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

describe("extractUserText", () => {
  it("takes the last user message, not the last message", () => {
    // Hermes reads a single `message` string; useChat posts the whole array. Picking
    // the wrong element replays an assistant turn back at the model as user input.
    // The assistant turn must be LAST here — with a user message at the tail, a
    // naive "last element" implementation passes by accident.
    const body = uiBody(["first", "reply", "second", "second reply"])
    expect(body.messages[body.messages.length - 1].role).toBe("assistant") // guard the fixture
    expect(extractUserText(body)).toBe("second")
  })

  it("skips a trailing assistant message with no user text after it", () => {
    const body = {
      messages: [
        { id: "m0", role: "user", parts: [{ type: "text", text: "q" }] },
        { id: "m1", role: "assistant", parts: [{ type: "text", text: "a" }] },
      ],
    }
    expect(extractUserText(body)).toBe("q")
  })

  it("joins multiple text parts of one message", () => {
    const body = {
      messages: [
        {
          id: "m0",
          role: "user",
          parts: [
            { type: "text", text: "a" },
            { type: "text", text: "b" },
          ],
        },
      ],
    }
    expect(extractUserText(body)).toBe("a\nb")
  })

  it("ignores non-text parts", () => {
    const body = {
      messages: [
        {
          id: "m0",
          role: "user",
          parts: [
            { type: "step-start" },
            { type: "text", text: "real" },
            { type: "file", url: "x" },
          ],
        },
      ],
    }
    expect(extractUserText(body)).toBe("real")
  })

  it("falls back to a bare message/input field", () => {
    expect(extractUserText({ message: "bare" })).toBe("bare")
    expect(extractUserText({ input: "inp" })).toBe("inp")
  })

  it("returns empty string when there is no user content", () => {
    expect(extractUserText({})).toBe("")
    expect(extractUserText({ messages: [] })).toBe("")
    expect(extractUserText(uiBody([]))).toBe("")
  })
})

describe("createHermesClient.ensureSession", () => {
  it("creates the session with the client-chosen id", async () => {
    const { impl, calls } = fakeFetch([jsonRes(201, { session: { id: "s1" } })])
    const c = createHermesClient({ baseUrl: BASE, apiKey: KEY, fetchImpl: impl })
    await c.ensureSession("s1")

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`${BASE}/api/sessions`)
    expect(JSON.parse(calls[0].init.body as string)).toMatchObject({ id: "s1" })
  })

  it("treats 409 as success — the session already exists", async () => {
    // The proxy cannot know whether a session was created on a previous turn, and a
    // pre-flight GET would double every turn's round-trips. Create-and-tolerate-409
    // is the cheap idempotent path; a thrown 409 would break every turn after the first.
    const { impl } = fakeFetch([jsonRes(409, { error: { code: "session_exists" } })])
    const c = createHermesClient({ baseUrl: BASE, apiKey: KEY, fetchImpl: impl })
    await expect(c.ensureSession("s1")).resolves.toBeUndefined()
  })

  it("throws on a real failure so the turn is not attempted blind", async () => {
    const { impl } = fakeFetch([jsonRes(401, { error: { message: "unauthorized" } })])
    const c = createHermesClient({ baseUrl: BASE, apiKey: KEY, fetchImpl: impl })
    await expect(c.ensureSession("s1")).rejects.toThrow(/401/)
  })

  it("sends the api key as a bearer token", async () => {
    const { impl, calls } = fakeFetch([jsonRes(201, {})])
    const c = createHermesClient({ baseUrl: BASE, apiKey: KEY, fetchImpl: impl })
    await c.ensureSession("s1")
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`)
  })
})

describe("createHermesClient.streamTurn", () => {
  it("posts the extracted text to the session stream endpoint", async () => {
    const body = { getReader: () => ({}) }
    const { impl, calls } = fakeFetch([
      jsonRes(201, {}),
      { ok: true, status: 200, body } as unknown as Response,
    ])
    const c = createHermesClient({ baseUrl: BASE, apiKey: KEY, fetchImpl: impl })
    await c.streamTurn({ sessionId: "s1", body: uiBody(["hello"]) })

    expect(calls[1].url).toBe(`${BASE}/api/sessions/s1/chat/stream`)
    expect(JSON.parse(calls[1].init.body as string)).toMatchObject({ message: "hello" })
  })

  it("forwards a system message when one is supplied", async () => {
    const { impl, calls } = fakeFetch([
      jsonRes(201, {}),
      { ok: true, status: 200, body: {} } as unknown as Response,
    ])
    const c = createHermesClient({ baseUrl: BASE, apiKey: KEY, fetchImpl: impl })
    await c.streamTurn({ sessionId: "s1", body: uiBody(["hi"]), systemMessage: "CONTEXT: x" })

    expect(JSON.parse(calls[1].init.body as string).system_message).toBe("CONTEXT: x")
  })

  it("omits system_message entirely when there is none", async () => {
    // An empty string would overwrite the agent's own system prompt with nothing.
    const { impl, calls } = fakeFetch([
      jsonRes(201, {}),
      { ok: true, status: 200, body: {} } as unknown as Response,
    ])
    const c = createHermesClient({ baseUrl: BASE, apiKey: KEY, fetchImpl: impl })
    await c.streamTurn({ sessionId: "s1", body: uiBody(["hi"]) })

    expect("system_message" in JSON.parse(calls[1].init.body as string)).toBe(false)
  })

  it("refuses an empty turn instead of posting a blank message", async () => {
    const { impl, calls } = fakeFetch([jsonRes(201, {})])
    const c = createHermesClient({ baseUrl: BASE, apiKey: KEY, fetchImpl: impl })
    await expect(c.streamTurn({ sessionId: "s1", body: {} })).rejects.toThrow(/empty/i)
    expect(calls).toHaveLength(0) // not even the session create
  })

  it("propagates an abort signal so Stop reaches the gateway", async () => {
    const ctrl = new AbortController()
    const { impl, calls } = fakeFetch([
      jsonRes(201, {}),
      { ok: true, status: 200, body: {} } as unknown as Response,
    ])
    const c = createHermesClient({ baseUrl: BASE, apiKey: KEY, fetchImpl: impl })
    await c.streamTurn({ sessionId: "s1", body: uiBody(["hi"]), signal: ctrl.signal })
    expect(calls[1].init.signal).toBe(ctrl.signal)
  })

  it("throws when the gateway rejects the turn", async () => {
    const { impl } = fakeFetch([jsonRes(201, {}), jsonRes(500, { error: { message: "boom" } })])
    const c = createHermesClient({ baseUrl: BASE, apiKey: KEY, fetchImpl: impl })
    await expect(c.streamTurn({ sessionId: "s1", body: uiBody(["hi"]) })).rejects.toThrow(/500/)
  })

  it("returns the upstream body stream for the translator to consume", async () => {
    const body = { marker: "the-stream" }
    const { impl } = fakeFetch([
      jsonRes(201, {}),
      { ok: true, status: 200, body } as unknown as Response,
    ])
    const c = createHermesClient({ baseUrl: BASE, apiKey: KEY, fetchImpl: impl })
    const out = await c.streamTurn({ sessionId: "s1", body: uiBody(["hi"]) })
    expect(out).toBe(body)
  })
})

describe("createHermesClient.stopRun", () => {
  it("posts to the run stop endpoint", async () => {
    const { impl, calls } = fakeFetch([jsonRes(200, { status: "stopping" })])
    const c = createHermesClient({ baseUrl: BASE, apiKey: KEY, fetchImpl: impl })
    await c.stopRun("run_abc")
    expect(calls[0].url).toBe(`${BASE}/v1/runs/run_abc/stop`)
    expect(calls[0].init.method).toBe("POST")
  })

  it("never throws — a failed stop must not mask the original abort", async () => {
    // stopRun is called from an abort handler. Throwing there replaces the real
    // reason the turn ended with a confusing secondary error, and in a stream
    // teardown path there is nobody left to catch it.
    const { impl } = fakeFetch([jsonRes(404, { error: "gone" })])
    const c = createHermesClient({ baseUrl: BASE, apiKey: KEY, fetchImpl: impl })
    await expect(c.stopRun("run_abc")).resolves.toBeUndefined()
  })

  it("swallows a network failure too", async () => {
    const { impl } = fakeFetch([new Error("ECONNREFUSED")])
    const c = createHermesClient({ baseUrl: BASE, apiKey: KEY, fetchImpl: impl })
    await expect(c.stopRun("run_abc")).resolves.toBeUndefined()
  })

  it("does nothing without a run id", async () => {
    const { impl, calls } = fakeFetch([])
    const c = createHermesClient({ baseUrl: BASE, apiKey: KEY, fetchImpl: impl })
    await c.stopRun(null)
    expect(calls).toHaveLength(0)
  })
})

describe("createHermesClient config", () => {
  it("refuses to construct without an api key", () => {
    // A keyless client would send unauthenticated requests that 401 on every turn,
    // surfacing as a generic panel error rather than a config mistake.
    expect(() => createHermesClient({ baseUrl: BASE, apiKey: "", fetchImpl: vi.fn() })).toThrow(
      /api key/i,
    )
  })

  it("refuses to construct without a base url", () => {
    expect(() => createHermesClient({ baseUrl: "", apiKey: KEY, fetchImpl: vi.fn() })).toThrow(
      /base url/i,
    )
  })

  it("strips a trailing slash from the base url", () => {
    const { impl, calls } = fakeFetch([jsonRes(201, {})])
    const c = createHermesClient({ baseUrl: `${BASE}/`, apiKey: KEY, fetchImpl: impl })
    return c.ensureSession("s1").then(() => {
      expect(calls[0].url).toBe(`${BASE}/api/sessions`)
    })
  })
})

describe("lockModel / sessionModel (t179)", () => {
  it("creates the session before locking it", async () => {
    // Found on deployed preview, invisible to every unit test that existed: locking an id the
    // gateway has never seen returns 404 `session_not_found`, and on a first turn that is EVERY
    // session. The lock failed silently, the turn ran on the default model, and the picker went
    // on displaying the model the user had chosen — the exact bug this feature fixes.
    const { impl, calls } = fakeFetch([
      jsonRes(201, { session: { id: "s1" } }),
      jsonRes(200, { object: "hermes.session.model_lock" }),
    ])
    const c = createHermesClient({ baseUrl: BASE, apiKey: KEY, fetchImpl: impl })

    expect(await c.lockModel("s1", "glm/glm-5.1")).toBe(true)
    expect(calls.map((x) => x.url)).toEqual([
      `${BASE}/api/sessions`,
      `${BASE}/api/sessions/s1/model`,
    ])
    expect(JSON.parse(calls[1].init.body as string)).toEqual({ model: "glm/glm-5.1" })
  })

  it("locks an already-existing session", async () => {
    // 409 from the create is the normal steady state, not a failure.
    const { impl } = fakeFetch([
      jsonRes(409, { error: "session_exists" }),
      jsonRes(200, { object: "hermes.session.model_lock" }),
    ])
    const c = createHermesClient({ baseUrl: BASE, apiKey: KEY, fetchImpl: impl })
    expect(await c.lockModel("s1", "glm/glm-5.1")).toBe(true)
  })

  it("reports a refused lock instead of throwing", async () => {
    // The turn still runs, on the previous model. Throwing would fail a turn over a preference.
    const { impl } = fakeFetch([jsonRes(409, {}), jsonRes(400, { error: "unknown model" })])
    const c = createHermesClient({ baseUrl: BASE, apiKey: KEY, fetchImpl: impl })
    expect(await c.lockModel("s1", "nope")).toBe(false)
  })

  it("survives a network failure on lock", async () => {
    const { impl } = fakeFetch([jsonRes(409, {}), new Error("ECONNREFUSED")])
    const c = createHermesClient({ baseUrl: BASE, apiKey: KEY, fetchImpl: impl })
    expect(await c.lockModel("s1", "fwd-sonnet")).toBe(false)
  })

  it("does not call the gateway without a model", async () => {
    const { impl, calls } = fakeFetch([])
    const c = createHermesClient({ baseUrl: BASE, apiKey: KEY, fetchImpl: impl })
    expect(await c.lockModel("s1", "")).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it("reads the session's currently pinned model", async () => {
    // This is what keeps a proxy restart from announcing a switch that never happened: the
    // gateway persists the lock, so it is the authoritative previous value.
    const { impl, calls } = fakeFetch([jsonRes(200, { session: { model: "glm/glm-5.1" } })])
    const c = createHermesClient({ baseUrl: BASE, apiKey: KEY, fetchImpl: impl })

    expect(await c.sessionModel("s1")).toBe("glm/glm-5.1")
    expect(calls[0].url).toBe(`${BASE}/api/sessions/s1`)
  })

  it("returns empty for an unknown session", async () => {
    // 404 is normal: the proxy asks before the session's first turn has created it. The body is
    // deliberately unparseable, which is what a real error response looks like — a fake that
    // returns clean JSON on a 404 lets a missing status check pass.
    const notFound = {
      ok: false,
      status: 404,
      json: async () => {
        throw new SyntaxError("Unexpected token in JSON")
      },
    }
    const { impl } = fakeFetch([notFound])
    const c = createHermesClient({ baseUrl: BASE, apiKey: KEY, fetchImpl: impl })
    expect(await c.sessionModel("s1")).toBe("")
  })

  it("survives a network failure on read", async () => {
    const { impl } = fakeFetch([new Error("down")])
    const c = createHermesClient({ baseUrl: BASE, apiKey: KEY, fetchImpl: impl })
    expect(await c.sessionModel("s1")).toBe("")
  })

  it("ignores a session body returned with an error status", async () => {
    // The status check is not redundant with the try/catch. A 5xx whose body still parses —
    // a proxy error page carrying a cached payload, a gateway mid-restart — would otherwise be
    // read as authoritative, and the proxy would skip a lock it actually needs to apply.
    const { impl } = fakeFetch([jsonRes(500, { session: { model: "glm/glm-5.1" } })])
    const c = createHermesClient({ baseUrl: BASE, apiKey: KEY, fetchImpl: impl })
    expect(await c.sessionModel("s1")).toBe("")
  })
})
