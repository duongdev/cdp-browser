// Chat BFF entrypoint (PSN-93). Boots the store, the provider registry, the /api/chat/* routes, and
// the WS hub on one Node http server. server.mjs reverse-proxies /api/chat/* + /api/chat/ws here.
//
// CHAT_PROVIDER=mock swaps in the in-memory MockProvider (hermetic e2e). Otherwise the TeamsProvider
// speaks server.mjs's /internal/teams/* (base TEAMS_UPSTREAM_URL, secret CHAT_INTERNAL_SECRET).

import type { Server } from "node:http"
import { serve } from "@hono/node-server"
import Database from "better-sqlite3"
import { Hono } from "hono"
import type { ChatService } from "./contract.ts"
import { MockProvider } from "./providers/mock-provider.ts"
import type { ChatProvider } from "./providers/provider.ts"
import { TeamsProvider } from "./providers/teams-provider.ts"
import { createRoutes } from "./routes.ts"
import { migrate } from "./store.ts"
import { attachWsHub } from "./ws-hub.ts"

const dbPath = process.env.CHAT_DB || "chat.db"
const db = migrate(new Database(dbPath))

const providers = new Map<ChatService, ChatProvider>()
if (process.env.CHAT_PROVIDER === "mock") providers.set("mock", new MockProvider("mock"))
else providers.set("teams", new TeamsProvider())

const app = new Hono()
app.get("/health", (c) => c.json({ ok: true, service: "chat-server" }))
app.route("/api/chat", createRoutes({ db, providers }))

const port = Number(process.env.CHAT_SERVER_PORT) || 7810

const nodeServer = serve({ fetch: app.fetch, port }, (info) => {
  console.info(`chat-server listening on :${info.port}`)
}) as Server

attachWsHub(nodeServer, db)

export { app }
