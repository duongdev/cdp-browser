// The `/api/chat/*` HTTP contract (PSN-93, Workstream C). Wires every route from contract.ts into
// a Hono router. A provider registry maps `service` → ChatProvider; reads/writes go through the
// provider, then persist to the store (decision 10: the DB is a durable platform, so every read
// keeps the raw payload). Local-only state (prefs, read-local) never touches the provider.
//
// The sweep (WS-D) drives background refresh + WS deltas — this workstream just makes the contract
// serve correctly, provider-first.

import type BetterSqlite3 from "better-sqlite3"
import { Hono } from "hono"
import type { BackfillStatus, ChatMessage, ChatService } from "./contract.ts"
import type { AvatarResult, ChatProvider, MediaBytes } from "./providers/provider.ts"
import { ProviderError } from "./providers/provider.ts"
import * as store from "./store.ts"
import { toConversationInput, toMessageInput } from "./upsert-map.ts"

type Db = BetterSqlite3.Database

/** The backfill accessor a service's engine exposes to the routes (WS-D wires the real one; absent
 *  → the routes report an idle status and reject a start). */
export interface BackfillAccessor {
  startBackfill(opts: { days?: number }): BackfillStatus
  getBackfillStatus(): BackfillStatus
}

export interface RoutesDeps {
  db: Db
  /** service id → provider. `service` defaults to "teams". */
  providers: Map<ChatService, ChatProvider>
  /** service id → backfill engine. Optional so tests/boot without an engine still serve the route. */
  backfills?: Map<ChatService, BackfillAccessor>
  /** The non-secret VAPID public key the FE uses as `applicationServerKey` (WS-G). Absent → the
   *  key route returns null and push is effectively disabled. */
  vapidPublicKey?: string
}

const DEFAULT_SERVICE = "teams"

/** Resolve the provider for a request's `service` (body or query), or throw a typed 400. */
function pick(deps: RoutesDeps, raw: unknown): { service: ChatService; provider: ChatProvider } {
  const service = (typeof raw === "string" && raw) || DEFAULT_SERVICE
  const provider = deps.providers.get(service)
  if (!provider) throw new ProviderError("unknown_service", 400)
  return { service, provider }
}

export function createRoutes(deps: RoutesDeps) {
  const app = new Hono()

  // Turn a thrown ProviderError (or anything) into the typed `{ error }` + non-2xx contract.
  app.onError((err, c) => {
    if (err instanceof ProviderError) return c.json({ error: err.code }, statusOf(err.status))
    return c.json({ error: (err as Error)?.message || "internal_error" }, 500)
  })

  // ---- reads (persist + return) -------------------------------------------

  app.post("/conversations", async (c) => {
    const b = await readBody(c)
    const { service, provider } = pick(deps, b.service)
    const page = await provider.listConversations(b.cursor ?? null)
    store.upsertConversations(deps.db, service, page.conversations.map(toConversationInput))
    return c.json(page)
  })

  app.post("/history", async (c) => {
    const b = await readBody(c)
    const { service, provider } = pick(deps, b.service)
    if (!b.convId) throw new ProviderError("missing_conv", 400)
    const page = await provider.fetchHistory(b.convId, b.cursor ?? null, !!b.poll)
    store.upsertMessages(deps.db, service, b.convId, page.messages.map(toMessageInput))
    persistSenders(deps.db, service, page.messages)
    return c.json(page)
  })

  // ---- writes (call provider, persist echo where useful) ------------------

  app.post("/reply", async (c) => {
    const b = await readBody(c)
    const { provider } = pick(deps, b.service)
    if (!b.convId) throw new ProviderError("missing_conv", 400)
    const result = await provider.sendReply(b.convId, b.text ?? "", {
      html: b.html ?? null,
      quotes: b.quotes,
      mentions: b.mentions,
    })
    return c.json(result)
  })

  app.post("/react", async (c) => {
    const b = await readBody(c)
    const { provider } = pick(deps, b.service)
    await provider.react(b.convId, b.msgId, b.key, !!b.remove)
    return c.json({ ok: true })
  })

  app.post("/edit", async (c) => {
    const b = await readBody(c)
    const { provider } = pick(deps, b.service)
    await provider.edit(b.convId, b.msgId, b.text ?? "")
    return c.json({ ok: true })
  })

  app.post("/delete", async (c) => {
    const b = await readBody(c)
    const { provider } = pick(deps, b.service)
    await provider.delete(b.convId, b.msgId)
    return c.json({ ok: true })
  })

  app.post("/roster", async (c) => {
    const b = await readBody(c)
    const { service, provider } = pick(deps, b.service)
    const members = await provider.roster(b.convId)
    store.upsertUsers(
      deps.db,
      service,
      members.map((m) => ({ id: m.id, displayName: m.name })),
    )
    return c.json({ members })
  })

  app.post("/upload-image", async (c) => {
    const b = await readBody(c)
    const { provider } = pick(deps, b.service)
    const r = await provider.uploadImage(
      b.convId,
      {
        filename: b.filename,
        base64: b.base64,
        contentType: b.contentType,
        width: b.width,
        height: b.height,
      },
      b.text,
    )
    return c.json(r)
  })

  app.post("/upload-images", async (c) => {
    const b = await readBody(c)
    const { provider } = pick(deps, b.service)
    const r = await provider.uploadImages(b.convId, b.images ?? [], b.text)
    return c.json(r)
  })

  app.post("/upload-file", async (c) => {
    const b = await readBody(c)
    const { provider } = pick(deps, b.service)
    const r = await provider.uploadFile(
      b.convId,
      { filename: b.filename, base64: b.base64, contentType: b.contentType },
      b.text,
    )
    return c.json(r)
  })

  // ---- profile / bytes (stream provider bytes back) -----------------------

  app.get("/profile", async (c) => {
    const { provider } = pick(deps, c.req.query("service"))
    const userId = c.req.query("userId")
    if (!userId) throw new ProviderError("missing_user", 400)
    return c.json({ profile: await provider.profile(userId) })
  })

  app.get("/avatar", async (c) => {
    const { provider } = pick(deps, c.req.query("service"))
    const userId = c.req.query("userId")
    if (!userId) throw new ProviderError("missing_user", 400)
    const r: AvatarResult = await provider.avatar(userId)
    if ("miss" in r) return c.json({ miss: true }, 404)
    return bytes(c, r)
  })

  app.get("/media", async (c) => {
    const { provider } = pick(deps, c.req.query("service"))
    const murl = c.req.query("url")
    if (!murl) throw new ProviderError("missing_url", 400)
    return bytes(c, await provider.media(murl))
  })

  // ---- prefs (store-local, no provider) -----------------------------------

  app.get("/prefs", (c) => {
    const service = c.req.query("service") || DEFAULT_SERVICE
    return c.json({
      prefs: store.getAllPrefs(deps.db, service),
      folderOrder: store.getFolderOrder(deps.db, service),
    })
  })

  app.post("/prefs", async (c) => {
    const b = await readBody(c)
    const service = b.service || DEFAULT_SERVICE
    if (Array.isArray(b.folderOrder)) {
      return c.json({ folderOrder: store.setFolderOrder(deps.db, service, b.folderOrder) })
    }
    if (!b.convId) throw new ProviderError("missing_conv", 400)
    const prefs = store.setPrefs(deps.db, service, b.convId, {
      labels: b.labels,
      folder: b.folder,
      muted: b.muted,
      mutedUntil: b.mutedUntil,
      notifyOnMention: b.notifyOnMention,
      customTitle: b.customTitle,
    })
    return c.json({ prefs })
  })

  // ---- read state ----------------------------------------------------------

  // Write-through: advance the provider's read horizon AND the local one.
  app.post("/mark-read", async (c) => {
    const b = await readBody(c)
    const { service, provider } = pick(deps, b.service)
    if (!b.convId) throw new ProviderError("missing_conv", 400)
    await provider.markRead(b.convId, b.msgId ?? "", Number(b.ts) || 0)
    store.markConversationRead(deps.db, service, b.convId, Number(b.ts) || 0)
    return c.json({ ok: true })
  })

  // Local-only: mark-read / mark-unread / open — never touches the provider.
  app.post("/read-local", async (c) => {
    const b = await readBody(c)
    const service = b.service || DEFAULT_SERVICE
    if (!b.convId) throw new ProviderError("missing_conv", 400)
    const ts = Number(b.ts) || 0
    if (b.action === "unread") store.markConversationUnread(deps.db, service, b.convId)
    else if (b.action === "read") store.markConversationRead(deps.db, service, b.convId, ts)
    else store.setLocalRead(deps.db, service, b.convId, ts)
    return c.json({ ok: true })
  })

  // ---- backfill (WS-D engine; idle status when no engine is wired) --------

  app.get("/backfill", (c) => {
    const service = c.req.query("service") || DEFAULT_SERVICE
    const engine = deps.backfills?.get(service)
    return c.json(engine ? engine.getBackfillStatus() : idleBackfill(service))
  })

  app.post("/backfill", async (c) => {
    const b = await readBody(c)
    const service = b.service || DEFAULT_SERVICE
    const engine = deps.backfills?.get(service)
    if (!engine) return c.json({ ok: true, ...idleBackfill(service) })
    if (b.action === "start") return c.json({ ok: true, ...engine.startBackfill({ days: b.days }) })
    return c.json({ ok: true, ...engine.getBackfillStatus() })
  })

  // ---- web push (BFF owns Teams push, WS-G) --------------------------------
  // The public key is non-secret (the FE's applicationServerKey). Subscribe stores the sub keyed by
  // endpoint; unsubscribe drops it. The sweep is the sender (see sweep.ts / push.ts).

  app.get("/push/vapid-public-key", (c) => c.json({ key: deps.vapidPublicKey ?? null }))

  app.post("/push/subscribe", async (c) => {
    const b = await readBody(c)
    const service = b.service || DEFAULT_SERVICE
    const sub = b.subscription
    if (!sub?.endpoint) throw new ProviderError("missing_endpoint", 400)
    store.savePushSub(deps.db, service, {
      endpoint: sub.endpoint,
      deviceId: b.deviceId,
      subscription: sub,
    })
    return c.json({ ok: true })
  })

  app.post("/push/unsubscribe", async (c) => {
    const b = await readBody(c)
    const service = b.service || DEFAULT_SERVICE
    if (!b.endpoint) throw new ProviderError("missing_endpoint", 400)
    store.deletePushSub(deps.db, service, b.endpoint)
    return c.json({ ok: true })
  })

  return app
}

// Hono maps our numeric status onto its ContentfulStatusCode union; clamp to a safe error range.
function statusOf(n: number): 400 | 403 | 404 | 429 | 500 | 502 {
  if (n === 400 || n === 403 || n === 404 || n === 429 || n === 500 || n === 502) return n
  return n >= 400 && n < 500 ? 400 : 502
}

async function readBody(c: {
  req: { json: () => Promise<unknown> }
  // biome-ignore lint/suspicious/noExplicitAny: request bodies are dynamic contract shapes
}): Promise<any> {
  try {
    return (await c.req.json()) ?? {}
  } catch {
    return {}
  }
}

// biome-ignore lint/suspicious/noExplicitAny: Hono's Context.body typing needs the DOM lib we don't ship
function bytes(c: any, r: MediaBytes) {
  // Copy into a plain ArrayBuffer so the value is a valid body regardless of the Uint8Array's backing.
  const buf = r.body.slice().buffer
  return c.body(buf, {
    headers: { "Content-Type": r.contentType, "X-Content-Type-Options": "nosniff" },
  })
}

// Cache sender display names off a history page so later name lookups hit the store.
function persistSenders(db: Db, service: string, messages: ChatMessage[]): void {
  const seen = new Map<string, string>()
  for (const m of messages) if (m.senderId && m.senderName) seen.set(m.senderId, m.senderName)
  if (seen.size)
    store.upsertUsers(
      db,
      service,
      [...seen].map(([id, displayName]) => ({ id, displayName })),
    )
}

function idleBackfill(service: string) {
  return {
    service,
    running: false,
    days: 30,
    conversationsDone: 0,
    conversationsTotal: 0,
    messagesFetched: 0,
  }
}
