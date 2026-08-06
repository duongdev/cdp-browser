// ADR-0025: `/mcp` is reverse-proxied to the chat BFF so off-host MCP clients reach it on the
// tailnet origin. These specs pin the routing contract, not the MCP server itself (that is
// apps/chat-server/src/mcp.test.ts): the path reaches the BFF, headers survive the hop — the
// `Origin` gate is what makes proxying safe, so it must see what the client sent — and an
// unreachable BFF is a clean 502.
//
// The upstream is a stub, not the real chat-server: this asserts the proxy layer in isolation, so
// a failure here means the route broke, not that retrieval broke.

import http from "node:http"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

const { startFakeCdpHost } = await import("./fake-cdp-host.mjs")
const { startWebServer } = await import("./server-harness.mjs")

/** Minimal stand-in for apps/chat-server: records what the proxy forwarded, echoes it back. */
async function startStubBff() {
  const seen: any[] = []
  const server = http.createServer((req, res) => {
    let body = ""
    req.on("data", (c) => {
      body += c
    })
    req.on("end", () => {
      seen.push({ url: req.url, method: req.method, headers: req.headers, body })
      // Mirror the MCP server's Origin gate so the header's survival is observable end-to-end.
      const origin = req.headers.origin
      const allowed =
        !origin ||
        origin.startsWith("http://localhost") ||
        origin.startsWith("http://127.0.0.1") ||
        origin.startsWith("http://[::1]")
      if (!allowed) {
        res.writeHead(403, { "Content-Type": "application/json" })
        res.end(
          JSON.stringify({ jsonrpc: "2.0", error: { code: -32600, message: "forbidden origin" } }),
        )
        return
      }
      // Streamable HTTP answers as SSE; assert the content type survives the pipe verbatim.
      res.writeHead(200, { "Content-Type": "text/event-stream" })
      res.end(
        `event: message\ndata: ${JSON.stringify({ result: { serverInfo: { name: "cdp-chats" } } })}\n\n`,
      )
    })
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const port = (server.address() as any).port
  return {
    port,
    seen,
    url: `http://127.0.0.1:${port}`,
    stop: () => new Promise<void>((r) => server.close(() => r())),
  }
}

const INIT = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "t", version: "0" },
  },
})

describe("/mcp reverse proxy (ADR-0025)", () => {
  let fake: any
  let bff: any
  let server: any

  beforeEach(async () => {
    fake = await startFakeCdpHost()
    bff = await startStubBff()
    server = await startWebServer(fake, { CHAT_SERVER_URL: bff.url })
  })

  afterEach(async () => {
    await server?.stop()
    await bff?.stop()
    await fake?.stop()
  })

  it("forwards POST /mcp to the chat BFF on the same path", async () => {
    const res = await server.fetch("/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: INIT,
    })

    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    expect(await res.text()).toContain("cdp-chats")

    expect(bff.seen).toHaveLength(1)
    expect(bff.seen[0].url).toBe("/mcp")
    expect(bff.seen[0].method).toBe("POST")
    // Plaintext JSON-RPC: the route sits above the E2E body decode, so the body arrives verbatim.
    expect(JSON.parse(bff.seen[0].body).method).toBe("initialize")
  })

  it("passes the Origin header through so the DNS-rebinding gate still sees it", async () => {
    const res = await server.fetch("/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Origin: "http://evil.example",
      },
      body: INIT,
    })

    // The gate lives upstream in mcp.ts; the proxy's job is not to swallow the header.
    expect(bff.seen[0].headers.origin).toBe("http://evil.example")
    expect(res.status).toBe(403)
  })

  it("supports GET /mcp (the streamable-HTTP server-to-client channel)", async () => {
    const res = await server.fetch("/mcp", { headers: { Accept: "text/event-stream" } })
    expect(res.status).toBe(200)
    expect(bff.seen[0].method).toBe("GET")
  })

  it("returns a clean 502 when the BFF is down, and does not crash the server", async () => {
    await bff.stop()

    const res = await server.fetch("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: INIT,
    })
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: "chat_upstream_unreachable" })

    // Still serving other routes — an upstream failure must not take the process with it.
    const health = await server.fetch("/api/tabs")
    expect(health.status).toBe(200)
  })
})
