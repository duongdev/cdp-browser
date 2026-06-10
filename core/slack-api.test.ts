import { describe, expect, it, vi } from "vitest"
// CommonJS module (server-side, Node). Cred-injected Slack web API client (t067).
import { createSlackApi } from "./slack-api"

// A fake fetch that records calls and returns scripted responses.
function fakeFetch(
  scripts: Array<{ status?: number; headers?: Record<string, string>; json: unknown }>,
) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  let i = 0
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const s = scripts[Math.min(i, scripts.length - 1)]
    i++
    return {
      ok: (s.status ?? 200) < 400,
      status: s.status ?? 200,
      headers: { get: (h: string) => s.headers?.[h.toLowerCase()] ?? null },
      json: async () => s.json,
    }
  })
  return { fn, calls }
}

const creds = { token: "xoxc-test-123", cookie: "xoxd-abc", baseUrl: "https://acme.slack.com" }

describe("createSlackApi auth + request shape", () => {
  it("POSTs to {baseUrl}/api/{method} with the d cookie header and token in the body", async () => {
    const { fn, calls } = fakeFetch([
      { json: { ok: true, channels: [], ims: [], mpims: [], threads: {} } },
    ])
    const api = createSlackApi({ ...creds, fetch: fn })
    await api.clientCounts()
    expect(calls.length).toBe(1)
    expect(calls[0].url).toBe("https://acme.slack.com/api/client.counts")
    expect(calls[0].init.method).toBe("POST")
    const headers = calls[0].init.headers as Record<string, string>
    expect(headers.Cookie).toContain("d=xoxd-abc")
    // token rides in the form body
    const body = calls[0].init.body as URLSearchParams
    expect(body.get("token")).toBe("xoxc-test-123")
  })

  it("defaults baseUrl to https://slack.com when omitted", async () => {
    const { fn, calls } = fakeFetch([{ json: { ok: true } }])
    const api = createSlackApi({ token: "t", cookie: "c", fetch: fn })
    await api.clientCounts()
    expect(calls[0].url).toBe("https://slack.com/api/client.counts")
  })
})

describe("clientCounts parse", () => {
  it("returns the parsed counts on ok", async () => {
    const counts = {
      ok: true,
      channels: [
        { id: "C1", last_read: "100.0", latest: "200.0", mention_count: 2, has_unreads: true },
      ],
      ims: [{ id: "D1", last_read: "50.0", latest: "60.0", mention_count: 0, has_unreads: true }],
      mpims: [],
      threads: { has_unreads: true, mention_count: 1 },
    }
    const { fn } = fakeFetch([{ json: counts }])
    const api = createSlackApi({ ...creds, fetch: fn })
    const res = await api.clientCounts()
    expect(res).toEqual(counts)
  })
})

describe("401 invalid_auth → typed result, not a throw", () => {
  it("returns { error: 'invalid_auth' } when Slack rejects the token", async () => {
    const { fn } = fakeFetch([{ json: { ok: false, error: "invalid_auth" } }])
    const api = createSlackApi({ ...creds, fetch: fn })
    const res = await api.clientCounts()
    expect(res).toEqual({ error: "invalid_auth" })
  })

  it("treats an HTTP 401 as invalid_auth too", async () => {
    const { fn } = fakeFetch([{ status: 401, json: {} }])
    const api = createSlackApi({ ...creds, fetch: fn })
    const res = await api.clientCounts()
    expect(res).toEqual({ error: "invalid_auth" })
  })
})

describe("429 rate limit → honors Retry-After then retries", () => {
  it("waits the Retry-After seconds and retries once", async () => {
    const { fn, calls } = fakeFetch([
      { status: 429, headers: { "retry-after": "1" }, json: {} },
      { json: { ok: true, channels: [] } },
    ])
    const sleep = vi.fn(async () => {})
    const api = createSlackApi({ ...creds, fetch: fn, sleep })
    const res = await api.clientCounts()
    expect(sleep).toHaveBeenCalledWith(1000)
    expect(calls.length).toBe(2)
    expect(res).toMatchObject({ ok: true })
  })
})

describe("conversationsHistory", () => {
  it("sends channel + oldest and returns messages", async () => {
    const { fn, calls } = fakeFetch([
      { json: { ok: true, messages: [{ type: "message", user: "U1", ts: "300.0", text: "hi" }] } },
    ])
    const api = createSlackApi({ ...creds, fetch: fn })
    const res = await api.conversationsHistory("C1", { oldest: "200.0", limit: 50 })
    const body = calls[0].init.body as URLSearchParams
    expect(calls[0].url).toBe("https://acme.slack.com/api/conversations.history")
    expect(body.get("channel")).toBe("C1")
    expect(body.get("oldest")).toBe("200.0")
    expect(body.get("inclusive")).toBe("false")
    expect(res).toMatchObject({ ok: true })
  })
})

describe("usersInfo", () => {
  it("sends the user id and returns the user object", async () => {
    const { fn, calls } = fakeFetch([
      {
        json: {
          ok: true,
          user: { name: "alice", real_name: "Alice A", profile: { display_name: "al" } },
        },
      },
    ])
    const api = createSlackApi({ ...creds, fetch: fn })
    const res = await api.usersInfo("U1")
    const body = calls[0].init.body as URLSearchParams
    expect(calls[0].url).toBe("https://acme.slack.com/api/users.info")
    expect(body.get("user")).toBe("U1")
    expect(res).toMatchObject({ ok: true })
  })
})
