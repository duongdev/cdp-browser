// Chat BFF entrypoint (PSN-93, Workstream A). Just enough to boot: a Hono app with a health
// probe. The provider seam, WS gateway, sweep, and /api/chat/* routes land in later workstreams.
import { serve } from "@hono/node-server"
import { Hono } from "hono"

const app = new Hono()

app.get("/health", (c) => c.json({ ok: true, service: "chat-server" }))

const port = Number(process.env.CHAT_SERVER_PORT) || 7810

serve({ fetch: app.fetch, port }, (info) => {
  console.info(`chat-server listening on :${info.port}`)
})

export { app }
