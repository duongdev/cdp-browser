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
import webpush from "web-push"
import { createAssistantRoutes } from "./assistant/routes.ts"
import { createBackfillEngine } from "./backfill.ts"
import type { ChatService } from "./contract.ts"
import { MockProvider } from "./providers/mock-provider.ts"
import type { ChatProvider } from "./providers/provider.ts"
import { TeamsProvider } from "./providers/teams-provider.ts"
import { createPushSender } from "./push.ts"
import { type BackfillAccessor, createRoutes } from "./routes.ts"
import { migrate } from "./store.ts"
import { createSweepEngine } from "./sweep.ts"
import { attachWsHub, broadcast, getFocusedConvIds } from "./ws-hub.ts"

const dbPath =
  process.env.CHAT_DB_PATH || (process.env.DATA_DIR ? `${process.env.DATA_DIR}/chat.db` : "chat.db")
const db = migrate(new Database(dbPath))

// VAPID keys for Teams web push (WS-G, decision 8). The public key is non-secret (it ships to every
// browser at subscribe time), so it keeps a default; the PRIVATE key is a secret and comes from env
// ONLY — no source default. Set VAPID_PRIVATE_KEY (+ optionally VAPID_PUBLIC_KEY/VAPID_SUBJECT) in
// prod to the same pair the browser PWA push uses, so both surfaces stay in sync and installed
// subscriptions survive. Without a private key, push is simply disabled (subscribe still works).
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:admin@example.com"
const VAPID_PUBLIC_KEY =
  process.env.VAPID_PUBLIC_KEY ||
  "BDIDtkQnVIAwcjjpgXgUSKLj6DGvZx_E9UMe4vzn1S-ih2rTIlZMGU_unzeBfIW6VSG_6bF8gUqMvMJUuHeZyzo"
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY
if (VAPID_PRIVATE_KEY) webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY)
else console.warn("[chat-server] VAPID_PRIVATE_KEY unset — Teams web push disabled")

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
app.route("/api/chat/assistant", createAssistantRoutes({ db }))
app.route("/api/chat", createRoutes({ db, providers, backfills, vapidPublicKey: VAPID_PUBLIC_KEY }))

const port = Number(process.env.CHAT_SERVER_PORT) || 7810

const nodeServer = serve({ fetch: app.fetch, port }, (info) => {
  console.info(`chat-server listening on :${info.port}`)
}) as Server

attachWsHub(nodeServer, db)

// Start the sweep once the hub is attached so `broadcast` reaches live clients. One engine per
// provider; each drives its own list + focus lanes off the shared hub.
for (const [service, provider] of providers) {
  // Only wire a push sender when a private key is configured — otherwise webpush has no VAPID
  // details and every sweep-triggered send would throw (swallowed, but noisy).
  const pushSender = VAPID_PRIVATE_KEY ? createPushSender({ db, service, webpush }) : undefined
  const sweep = createSweepEngine({
    db,
    provider,
    service,
    broadcast,
    getFocusedConvIds,
    pushSender,
  })
  sweep.start()
}

export { app }
