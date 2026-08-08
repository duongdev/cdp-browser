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
import { type Captioner, createCaptioner, downscaleImage } from "./caption.ts"
import type { ChatService } from "./contract.ts"
import { createHydrateEngine } from "./hydrate.ts"
import { resolveCaptionModel } from "./llm.ts"
import { mountMcp } from "./mcp.ts"
import { MediaCache } from "./media-cache.ts"
import { findByObjectId } from "./media-store.ts"
import { MOCK_PREFS, MockProvider } from "./providers/mock-provider.ts"
import type { ChatProvider } from "./providers/provider.ts"
import { ProviderError } from "./providers/provider.ts"
import { TeamsProvider } from "./providers/teams-provider.ts"
import { createPushSender } from "./push.ts"
import { type BackfillAccessor, createRoutes, type HydrateAccessor, statusOf } from "./routes.ts"
import { markConversationRead, markConversationUnread, migrate, setPrefs } from "./store.ts"
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
let mock: { service: ChatService; provider: MockProvider } | null = null
if (process.env.CHAT_PROVIDER === "mock") {
  // Default "mock" service id for hermetic e2e; CHAT_MOCK_SERVICE=teams lets the real FE (which
  // pins service "teams") run against fixtures for local visual dev.
  const mockService = (process.env.CHAT_MOCK_SERVICE || "mock") as ChatService
  const provider = new MockProvider(mockService)
  providers.set(mockService, provider)
  mock = { service: mockService, provider }
  // Mute / rename / folder are BFF-local prefs the provider can't express — seed them so those
  // row states are reachable in the local mock stack.
  for (const { convId, patch } of MOCK_PREFS) setPrefs(db, mockService, convId, patch)
} else providers.set("teams", new TeamsProvider())

// A backfill engine per provider; the routes read/start through this map.
const backfills = new Map<ChatService, BackfillAccessor>()
for (const [service, provider] of providers) {
  backfills.set(service, createBackfillEngine({ db, provider, service, broadcast }))
}

// A hydrate engine per provider (PSN-115 WS-B); the search route (WS-D) fires it for substrate hits
// not yet in chat.db. The engine itself is optional on RoutesDeps — its absence only means
// substrate rows stay `hydrated:false` until a sweep picks them up.
const hydrates = new Map<ChatService, HydrateAccessor>()
for (const [service, provider] of providers) {
  hydrates.set(service, createHydrateEngine({ db, provider, service, broadcast }))
}

// Image transcription (PSN-104): one worker per provider, draining the `message_media` rows
// `upsertMessages` leaves behind. The assistant's `view_image` and the lightbox's caption endpoint
// share the worker, so an image is fetched + transcribed once no matter who asks first.
const captioners = new Map<ChatService, Captioner>()
for (const [service, provider] of providers) {
  captioners.set(
    service,
    createCaptioner({
      db,
      service,
      provider,
      getModel: () => resolveCaptionModel(),
    }),
  )
}

// The assistant is single-service today (the FE pins one), so it reads images through whichever
// provider is registered — "teams" in prod, the mock under either id in the fixture harness.
const [assistantService, assistantProvider] = providers.entries().next().value ?? []
const assistantCaptioner = assistantService ? captioners.get(assistantService) : undefined

// Shared image-fetch path for the in-app assistant + the MCP `view_image` tool (PSN-114). Both
// resolve an AMS object id → provider.media bytes → downscaled, captioning lazily on demand.
const assistantVision =
  assistantService && assistantProvider && assistantCaptioner
    ? {
        async fetchImage(objectId: string) {
          const row = findByObjectId(db, assistantService, objectId)[0]
          if (!row) return null
          try {
            const media = await assistantProvider.media(row.url)
            if ("miss" in media) return null
            return await downscaleImage(media.body, media.contentType)
          } catch (e) {
            console.warn(`[assistant] image fetch failed: ${(e as Error)?.message ?? e}`)
            return null
          }
        },
        captionImage: (objectId: string) => assistantCaptioner.captionObject(objectId),
      }
    : undefined

// Shared substrate-search data plane (PSN-115 WS-C) for the in-app assistant + the MCP
// `search_messages` tool (PSN-114 D10): provider substrate search + the hydrate pipeline. Absent
// only when no hydrate engine is registered for this service (a misconfigured provider).
const assistantSearch =
  assistantService && hydrates.get(assistantService) && assistantProvider
    ? {
        provider: assistantProvider,
        hydrate: hydrates.get(assistantService) as import("./hydrate.ts").HydrateEngine,
      }
    : undefined

// Disk LRU cache for proxied AMS media (t185). Objects are immutable, so caching is permanent
// until evicted by size. Default 500MB, configurable via CHAT_MEDIA_CACHE_MB.
const mediaCacheDir =
  process.env.CHAT_MEDIA_CACHE_DIR ||
  (process.env.DATA_DIR ? `${process.env.DATA_DIR}/media-cache` : "media-cache")
const mediaCache = new MediaCache({
  dir: mediaCacheDir,
  maxBytes: (Number(process.env.CHAT_MEDIA_CACHE_MB) || 500) * 1024 * 1024,
})

const app = new Hono()
// Routes mounted directly on the root app (the mock harness) get the same typed error mapping as
// /api/chat — a ProviderError("not_found", 404) must read as 404, not as a bare 500 (QE DEF-8).
app.onError((err, c) => {
  if (err instanceof ProviderError) return c.json({ error: err.code }, statusOf(err.status))
  return c.json({ error: (err as Error)?.message || "internal_error" }, 500)
})
app.get("/health", (c) => c.json({ ok: true, service: "chat-server" }))
// MCP server at /mcp (PSN-114, ADR-0023/0024). Streamable HTTP, stateless. The Origin gate lives in
// mountMcp; the route is mounted before /api/chat but on a distinct path. Write tools (ADR-0026)
// are wired only when a provider exists for the assistant service; they reuse that provider and the
// same store fns /mark-read uses, so there is one write path, not an MCP-specific one.
if (assistantService)
  await mountMcp(app, {
    db,
    service: assistantService,
    vision: assistantVision,
    search: assistantSearch,
    write: assistantProvider
      ? {
          provider: assistantProvider,
          markConversationRead: (convId, ts) =>
            markConversationRead(db, assistantService, convId, ts),
          markConversationUnread: (convId, ts) =>
            markConversationUnread(db, assistantService, convId, ts),
        }
      : undefined,
  })
app.route(
  "/api/chat/assistant",
  createAssistantRoutes({
    db,
    search: assistantSearch,
    vision: assistantVision,
  }),
)
// Sweep engines created before routes so getSyncLog can be wired at startup.
const sweepEngines = new Map<ChatService, import("./sweep.ts").SweepEngine>()

// Local-only inbound simulator (PSN-105 I). Mock provider only — with a real provider this route
// does not exist. Appends an inbound message and runs the list sweep immediately, so the full
// delivery path (WS delta → FE, web push, Electron notification, dock badge) fires on demand and
// "does it arrive while minimised?" is testable with no tenant. Registered before the real
// /api/chat routes so it isn't shadowed.
//   curl -X POST localhost:7800/api/chat/mock/say -d '{"text":"ping"}'
if (mock) {
  const { service, provider } = mock
  app.all("/api/chat/mock/say", async (c) => {
    const q = c.req.query()
    const body = c.req.method === "POST" ? await c.req.json().catch(() => ({})) : {}
    const sent = provider.inject(body.convId ?? q.convId, body.text ?? q.text)
    await sweepEngines.get(service)?.runListOnce()
    return c.json({ ok: true, ...sent })
  })
}

app.route(
  "/api/chat",
  createRoutes({
    db,
    providers,
    backfills,
    hydrates,
    captioners,
    vapidPublicKey: VAPID_PUBLIC_KEY,
    // null when no sweep engine is running — the route turns that into a real error status so the
    // client can say "unreachable" instead of rendering it as an empty log (QE DEF-6).
    getSyncLog: () => sweepEngines.values().next().value?.getSyncLog() ?? null,
    // Suggestion batches fan out to every client (ADR-0027) — same hub the sweep pushes deltas on.
    broadcast,
    mediaCache,
  }),
)

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
  sweepEngines.set(service, sweep)
  sweep.start()
}

for (const captioner of captioners.values()) captioner.start()

export { app }
