// Chat BFF entrypoint (PSN-93). Boots the store, the provider registry, the sweep + backfill
// engines, the /api/chat/* routes, and the WS hub on one Node http server. server.mjs
// reverse-proxies /api/chat/* + /api/chat/ws here.
//
// CHAT_PROVIDER=mock swaps in the in-memory MockProvider (hermetic e2e). Otherwise the TeamsProvider
// speaks server.mjs's /internal/teams/* (base TEAMS_UPSTREAM_URL, secret CHAT_INTERNAL_SECRET).
//
// The sweep + backfill engines are wired here (not on import) so unit tests that import individual
// modules never spin up timers or hit a provider.

import type { Server } from "node:http"
import { serve } from "@hono/node-server"
import Database from "better-sqlite3"
import { Hono } from "hono"
import { createBackfillEngine } from "./backfill.ts"
import type { ChatService } from "./contract.ts"
import { MockProvider } from "./providers/mock-provider.ts"
import type { ChatProvider } from "./providers/provider.ts"
import { TeamsProvider } from "./providers/teams-provider.ts"
import { type BackfillAccessor, createRoutes } from "./routes.ts"
import { migrate } from "./store.ts"
import { createSweepEngine } from "./sweep.ts"
import { attachWsHub, broadcast, getFocusedConvIds } from "./ws-hub.ts"

const dbPath = process.env.CHAT_DB || "chat.db"
const db = migrate(new Database(dbPath))

const providers = new Map<ChatService, ChatProvider>()
if (process.env.CHAT_PROVIDER === "mock") providers.set("mock", new MockProvider("mock"))
else providers.set("teams", new TeamsProvider())

// A backfill engine per provider; the routes read/start through this map.
const backfills = new Map<ChatService, BackfillAccessor>()
for (const [service, provider] of providers) {
  backfills.set(service, createBackfillEngine({ db, provider, service, broadcast }))
}

const app = new Hono()
app.get("/health", (c) => c.json({ ok: true, service: "chat-server" }))
app.route("/api/chat", createRoutes({ db, providers, backfills }))

const port = Number(process.env.CHAT_SERVER_PORT) || 7810

const nodeServer = serve({ fetch: app.fetch, port }, (info) => {
  console.info(`chat-server listening on :${info.port}`)
}) as Server

attachWsHub(nodeServer, db)

// Start the sweep once the hub is attached so `broadcast` reaches live clients. One engine per
// provider; each drives its own list + focus lanes off the shared hub.
for (const [service, provider] of providers) {
  const sweep = createSweepEngine({ db, provider, service, broadcast, getFocusedConvIds })
  sweep.start()
}

export { app }
