// The `/api/chat/*` HTTP contract (PSN-93, Workstream C). Wires every route from contract.ts into
// a Hono router. A provider registry maps `service` → ChatProvider; reads/writes go through the
// provider, then persist to the store (decision 10: the DB is a durable platform, so every read
// keeps the raw payload). Local-only state (prefs) never touches the provider; read state does.
//
// The sweep (WS-D) drives background refresh + WS deltas — this workstream just makes the contract
// serve correctly, provider-first.

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type BetterSqlite3 from "better-sqlite3"
import { Hono } from "hono"
import type {
  BackfillStatus,
  ChatConversation,
  ChatMessage,
  ChatService,
  SearchHit,
  SearchPage,
  SearchScope,
} from "./contract.ts"
import { MAX_VERSIONS_PER_MESSAGE } from "./edit-history.ts"
import { amsObjectId, amsUrlFromSrc } from "./media-images.ts"
import { findByObjectId } from "./media-store.ts"
import type {
  AvatarResult,
  ChatProvider,
  MediaBytes,
  ProviderSearchHit,
} from "./providers/provider.ts"
import { ProviderError } from "./providers/provider.ts"
import { listConversationsByQuery, resolvePerson, resolveScope, searchMessages } from "./search.ts"
import { parseQuery } from "./search-query.ts"
import * as store from "./store.ts"
import { toConversationInput, toMessageInput } from "./upsert-map.ts"

// Read version from the monorepo root package.json so the BFF reports the same
// version as the web build — not a stale "0.0.0" from its own private package.json.
// ponytail: read-once at startup, no watch; restart picks up a version bump.
const _rootPkg = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "package.json"),
    "utf8",
  ),
) as { version: string }
const ROOT_VERSION = _rootPkg.version

type Db = BetterSqlite3.Database

/** The backfill accessor a service's engine exposes to the routes (WS-D wires the real one; absent
 *  → the routes report an idle status and reject a start). */
export interface BackfillAccessor {
  startBackfill(opts: { days?: number }): BackfillStatus
  getBackfillStatus(): BackfillStatus
}

/** The hydrate accessor a service's engine exposes (PSN-115 WS-B/D). Optional so tests/boot without
 *  an engine still serve the search route — substrate hits just stay `hydrated:false` until the
 *  next sweep picks the conversation up. */
export interface HydrateAccessor {
  /** Fire-and-forget batched hydrate for substrate hits not yet in chat.db. The route does NOT
   *  await this; completion reaches the FE via the existing `messages-upsert` WS delta. */
  hydrateHits(hits: ProviderSearchHit[]): Promise<unknown>
}

export interface RoutesDeps {
  db: Db
  /** service id → provider. `service` defaults to "teams". */
  providers: Map<ChatService, ChatProvider>
  /** service id → backfill engine. Optional so tests/boot without an engine still serve the route. */
  backfills?: Map<ChatService, BackfillAccessor>
  /** service id → hydrate engine (PSN-115). Optional — the search route degrades to local-only
   *  hydrate-deferred rows when no engine is wired (e.g. unit tests). */
  hydrates?: Map<ChatService, HydrateAccessor>
  /** The non-secret VAPID public key the FE uses as `applicationServerKey` (WS-G). Absent → the
   *  key route returns null and push is effectively disabled. */
  vapidPublicKey?: string
  /** service id → image transcription worker (PSN-104). Absent → `/media/caption` reports whatever
   *  is stored and never transcribes on demand. */
  captioners?: Map<ChatService, { captionObject(objectId: string): Promise<string | null> }>
  /** Sync log accessor — wired by index.ts when a sweep engine exists. `null` means no engine is
   *  running, which the route reports as a real failure, not an empty log. */
  getSyncLog?: () => import("./sweep.ts").SyncLogData | null
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
    // Return the STORE's rows for this page, not the provider's: read state is derived (PSN-102 —
    // a mark-unread bookmark lowers `readTs` and sets `unreadSticky`), and only the store knows it.
    // Provider order is preserved so the client's cursor paging still appends in place.
    const derived = new Map(store.listConversations(deps.db, service).map((row) => [row.id, row]))
    return c.json({
      ...page,
      conversations: page.conversations.map((row) => derived.get(row.id) ?? row),
    })
  })

  app.post("/history", async (c) => {
    const b = await readBody(c)
    const { service, provider } = pick(deps, b.service)
    if (!b.convId) throw new ProviderError("missing_conv", 400)
    // DB-served jump windows (t175): around a target / after a ts / before a ts — no provider
    // cursor walk, the store already holds the cited message. `missing: true` is the honest
    // target-not-synced fallback.
    if (b.aroundMsgId) {
      const win = store.listMessagesAround(deps.db, service, b.convId, String(b.aroundMsgId))
      if (!win) return c.json({ messages: [], missing: true, hasOlder: false, hasNewer: false })
      return c.json({
        messages: win.messages.map((m) => toChatMessage(service, m)),
        hasOlder: win.hasOlder,
        hasNewer: win.hasNewer,
      })
    }
    if (Number.isFinite(b.afterTs)) {
      const page2 = store.listMessagesAfter(deps.db, service, b.convId, Number(b.afterTs))
      return c.json({
        messages: page2.messages.map((m) => toChatMessage(service, m)),
        hasNewer: page2.hasNewer,
      })
    }
    if (Number.isFinite(b.beforeTs)) {
      const page2 = store.listMessagesBefore(deps.db, service, b.convId, Number(b.beforeTs))
      return c.json({
        messages: page2.messages.map((m) => toChatMessage(service, m)),
        hasOlder: page2.hasOlder,
      })
    }
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

  // A message's local version history (PSN-105 C). Teams keeps no previous version, so this reads
  // ONLY what our sweep observed and snapshotted — nothing is fetched from the provider. `truncated`
  // means the per-message cap was hit and older versions were dropped; the UI says so out loud.
  app.get("/message-history", (c) => {
    const { service } = pick(deps, c.req.query("service"))
    const convId = c.req.query("convId")
    const msgId = c.req.query("msgId")
    if (!convId || !msgId) throw new ProviderError("missing_message", 400)
    const { versions, truncated } = store.listMessageEdits(deps.db, service, convId, msgId)
    const row = store.getMessage(deps.db, service, convId, msgId)
    return c.json({
      versions,
      current: row ? { body: row.body, deleted: row.deleted, ts: row.ts ?? null } : null,
      truncated,
      cap: MAX_VERSIONS_PER_MESSAGE,
    })
  })

  // ---- profile / bytes (stream provider bytes back) -----------------------

  app.get("/profile", async (c) => {
    const { provider } = pick(deps, c.req.query("service"))
    const userId = c.req.query("userId")
    if (!userId) throw new ProviderError("missing_user", 400)
    return c.json({ profile: await provider.profile(userId) })
  })

  // Global people suggestions for the search box's `from:` operator (PSN-115 follow-up). The
  // composer's @-mention uses per-conversation `fetchRoster`, useless for a GLOBAL `from:` — this
  // reads the `users` cache (everyone the BFF has seen) via the existing pure `resolvePerson`,
  // fold-matched so "ann" finds "Ann Wong". Capped; empty query returns the most-recent few.
  app.get("/people", (c) => {
    const { service } = pick(deps, c.req.query("service"))
    const q = (c.req.query("q") ?? "").toString().trim()
    // `resolvePerson` is a MATCHER — it returns nothing for an empty needle. A bare `from:` (no
    // letters typed yet) must still show a starter list, or the dropdown looks broken, so fall
    // back to the most-recently-seen names.
    const people = q
      ? resolvePerson(deps.db, service, { name: q, limit: 8 })
      : store.listRecentUsers(deps.db, service, 8)
    return c.json({ people })
  })

  app.get("/avatar", async (c) => {
    const { provider } = pick(deps, c.req.query("service"))
    const userId = c.req.query("userId")
    if (!userId) throw new ProviderError("missing_user", 400)
    const r: AvatarResult = await provider.avatar(userId, c.req.query("size"))
    if ("miss" in r) return c.json({ miss: true }, 404)
    return bytes(c, r)
  })

  app.get("/media", async (c) => {
    const { provider } = pick(deps, c.req.query("service"))
    const murl = c.req.query("url")
    if (!murl) throw new ProviderError("missing_url", 400)
    return bytes(c, await provider.media(murl))
  })

  // An inline image's transcription (PSN-104), keyed by the media url the client already renders.
  // A stored one returns instantly; an un-transcribed image (everything from before this shipped)
  // is transcribed on demand — the lazy backfill, so old screenshots cost nothing until looked at.
  app.get("/media/caption", async (c) => {
    const { service } = pick(deps, c.req.query("service"))
    const convId = c.req.query("convId")
    const msgId = c.req.query("msgId")
    const url = c.req.query("url")
    if (!convId || !msgId || !url) throw new ProviderError("missing_url", 400)
    const ams = amsUrlFromSrc(url)
    const objectId = ams ? amsObjectId(ams) : null
    if (!objectId) return c.json({ status: "unsupported", caption: null })
    // A message stored before this shipped has no media rows; register them from its body now —
    // the lazy backfill (grilled), so old screenshots cost nothing until someone looks at one.
    store.recordImages(deps.db, service, convId, msgId)
    const row = findByObjectId(deps.db, service, objectId)[0]
    if (row?.caption) return c.json({ status: "done", caption: row.caption })
    const worker = deps.captioners?.get(service)
    if (!worker) return c.json({ status: row?.status ?? "pending", caption: null })
    const caption = await worker.captionObject(objectId)
    if (caption) return c.json({ status: "done", caption })
    // No caption and no failure row means transcription is simply unavailable (no vision model
    // configured) — reporting "failed" there would blame the image for a missing setting.
    const after = findByObjectId(deps.db, service, objectId)[0]
    return c.json({ status: after?.status === "failed" ? "failed" : "pending", caption: null })
  })

  // ---- Giphy proxy (PSN-94 D/E, no provider) ------------------------------
  // GIF + sticker search for the composer. The API key lives server-side (GIPHY_API_KEY) so it never
  // ships in the client bundle. Empty query → trending. Any failure (no key, Giphy down) returns an
  // empty list so the picker degrades to its empty state, never a hard error.
  app.get("/giphy", async (c) => {
    const key = process.env.GIPHY_API_KEY
    if (!key) return c.json({ items: [], error: "no_giphy_key" })
    const kind = c.req.query("kind") === "stickers" ? "stickers" : "gifs"
    const q = (c.req.query("q") || "").trim()
    const base = `https://api.giphy.com/v1/${kind}`
    const common = `api_key=${key}&limit=24&rating=pg-13`
    const url = q
      ? `${base}/search?${common}&q=${encodeURIComponent(q)}`
      : `${base}/trending?${common}`
    try {
      const r = await fetch(url)
      if (!r.ok) return c.json({ items: [], error: `giphy_${r.status}` })
      const j = (await r.json()) as { data?: unknown[] }
      const items = (j.data ?? [])
        .map((g) => {
          const e = g as {
            id?: string
            images?: { original?: Record<string, string>; fixed_width?: Record<string, string> }
          }
          const orig = e.images?.original
          if (!e.id || !orig?.url) return null
          const prev = e.images?.fixed_width ?? orig
          return {
            id: e.id,
            url: orig.url,
            previewUrl: prev.url ?? orig.url,
            width: Number(orig.width) || 220,
            height: Number(orig.height) || 220,
          }
        })
        .filter(Boolean)
      return c.json({ items })
    } catch {
      return c.json({ items: [], error: "giphy_failed" })
    }
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

  // ---- search (PSN-115 WS-D) -----------------------------------------------
  // One request-response: merge local FTS + substrate, dedupe by (convId,msgId), apply sort +
  // scope, return the merged row list. Background hydrate-on-render rides the existing WS delta hub
  // (hydrate goes through store.upsertMessages → the existing `messages-upsert` delta fires → the
  // open search view flips `hydrated:false` rows in place). NO SSE, no new transport.
  app.post("/search", async (c) => {
    const b = await readBody(c)
    const { service, provider } = pick(deps, b.service)
    const query: string = typeof b.query === "string" ? b.query : ""
    const parsed = parseQuery(query)
    const sort: "relevance" | "recent" = b.sort === "recent" ? "recent" : "relevance"
    const scope: SearchScope = b.scope && typeof b.scope === "object" ? b.scope : { kind: "all" }

    // Conv-id → {title, kind} for snippet/scope resolution. Built once; substrate hits may
    // reference convs we have never ingested, in which case title stays null and kind is unknown.
    const convs = new Map<string, { title: string | null; kind: ChatConversation["kind"] | null }>()
    for (const cv of store.listConversations(deps.db, service)) {
      convs.set(cv.id, { title: cv.title ?? cv.topic ?? null, kind: cv.kind })
    }

    // ---- LOCAL leg: FTS over the folded shadow index ----------------------
    // Filters we can honour natively: sender (resolvePerson → id), conv (in: → convId), date range,
    // mentionsMe. `has:` is FTS-unsupported today — when present, the local leg is empty (honest:
    // we'd rather show zero local than wrong local). The substrate leg can still surface them.
    let localHits: SearchHit[] = []
    const ff = parsed.filters
    const hasUnsupportedByFts = ff.has && ff.has.length > 0
    let localSkipped = false
    if (!hasUnsupportedByFts) {
      const senderId =
        ff.from === undefined
          ? undefined
          : resolvePerson(deps.db, service, { name: ff.from })[0]?.id
      // `from:` set but unresolved locally → no local hits (don't fall through to unfiltered).
      if (ff.from === undefined || senderId !== undefined) {
        let convIdFilter: string | undefined
        if (ff.in !== undefined) {
          // Resolve `in:` to a convId by title/topic/`in:`-literal match. None → no local hits.
          const matches = listConversationsByQuery(deps.db, service, { query: ff.in, limit: 5 })
          if (!matches.length) {
            localSkipped = true
          } else if (matches.length === 1) {
            convIdFilter = matches[0].id
          } else {
            // Ambiguous name → narrow with exact-title preference, else first match.
            const want = ff.in.toLowerCase()
            const exact = matches.find((m) => (m.title ?? "").toLowerCase() === want)
            convIdFilter = (exact ?? matches[0]).id
          }
        }
        if (!localSkipped) {
          const ftsHits = searchMessages(deps.db, {
            query: parsed.text,
            service,
            sender: senderId,
            convId: convIdFilter,
            after: ff.afterTs,
            before: ff.beforeTs,
            mentionsMe: ff.mentionsMe,
            limit: 50,
          })
          localHits = ftsHits.map((h) => {
            const cv = convs.get(h.convId)
            return {
              convId: h.convId,
              msgId: h.msgId,
              ts: h.ts ?? 0,
              sender: h.senderName ?? h.senderId ?? "",
              convTitle: cv?.title ?? null,
              convKind: cv?.kind ?? null,
              snippet: h.snippet,
              source: "local" as const,
              hydrated: true,
            }
          })
        }
      }
    }

    // ---- SUBSTRATE leg: provider searchMessages ---------------------------
    // We pass only the free-text substring — operators were extracted by the parser and are applied
    // as post-filters below so local + substrate honour them uniformly.
    const substrateHits: SearchHit[] = []
    let degraded: SearchPage["degraded"] | undefined
    const substrateProviderHits: ProviderSearchHit[] = []
    // Substrate is a full-text search — it can't be filtered by sender/conv, only by query text.
    // So an operators-only query (`from:"Ann"` with no free text) skips substrate entirely and
    // relies on the local sender/conv scan above (the old fallback to the raw query string sent
    // `from:"Ann"` to substrate as a search term and returned nothing).
    const substrateQueryText = parsed.text.trim()
    if (substrateQueryText) {
      try {
        const page = await provider.searchMessages(substrateQueryText, {
          sort,
          cursor: b.cursor ?? null,
        })
        for (const ph of page.rows) {
          substrateProviderHits.push(ph)
          const cv = convs.get(ph.convId)
          substrateHits.push({
            convId: ph.convId,
            msgId: ph.msgId,
            ts: ph.ts,
            sender: ph.sender,
            convTitle: cv?.title ?? null,
            convKind: cv?.kind ?? null,
            snippet: ph.preview,
            source: "substrate",
            hydrated: store.hasMessage(deps.db, service, ph.convId, ph.msgId),
          })
        }
      } catch (err) {
        // Substrate auth/rate-limit/transport failure → degrade to local-only (honest signal).
        // Non-ProviderError still counts as `upstream_error` — never crash the search route.
        if (err instanceof ProviderError) {
          degraded = err.code === "rate_limited" ? "rate_limited" : "auth"
        } else {
          degraded = "upstream_error"
        }
      }
    }

    // ---- MERGE + DEDUPE ----------------------------------------------------
    // Local wins on (convId,msgId) collisions: it's the authoritative/hydrated copy. The dedupe
    // key is the message identity, so a substrate hit pointing at a message already in chat.db is
    // replaced by the local row (which carries `hydrated:true` + an FTS snippet).
    const seen = new Set<string>()
    const merged: SearchHit[] = []
    for (const h of localHits) {
      const k = `${h.convId}:${h.msgId}`
      if (seen.has(k)) continue
      seen.add(k)
      merged.push(h)
    }
    for (const h of substrateHits) {
      const k = `${h.convId}:${h.msgId}`
      if (seen.has(k)) continue
      seen.add(k)
      merged.push(h)
    }

    // ---- POST-FILTERS on the merged set -----------------------------------
    // `from:`/`in:` post-filter both legs uniformly (local already narrowed where it could).
    // `has:` is FTS-unsupported locally, so it effectively narrows the substrate leg only.
    const filtered = merged.filter((h) => {
      if (ff.from !== undefined) {
        const want = ff.from.toLowerCase()
        if (!h.sender.toLowerCase().includes(want)) return false
      }
      if (ff.in !== undefined) {
        const want = ff.in.toLowerCase()
        const titleMatch = (h.convTitle ?? "").toLowerCase().includes(want)
        const idMatch = h.convId.toLowerCase().includes(want)
        if (!titleMatch && !idMatch) return false
      }
      return true
    })

    // ---- SCOPE ------------------------------------------------------------
    // dm/group from the conv's stored kind; folder/label resolved via resolveScope. Empty convIds
    // under folder/label = "nothing qualifies", NOT "unfiltered" (matches search.ts convention).
    let scoped = filtered
    if (scope.kind === "dm" || scope.kind === "group") {
      scoped = filtered.filter((h) => {
        const kind = convs.get(h.convId)?.kind
        return scope.kind === "dm" ? kind === "oneOnOne" : kind === "group"
      })
    } else if (scope.kind === "folder" || scope.kind === "label") {
      const resolved = resolveScope(deps.db, service, scope.name)
      const ids = resolved ? new Set(resolved.convIds) : new Set<string>()
      scoped = filtered.filter((h) => ids.has(h.convId))
    }

    // ---- SORT -------------------------------------------------------------
    // `recent` → ts desc. `relevance` → preserve substrate's native rank (Microsoft owns ranking),
    // local FTS hits (already bm25-ranked inside their own set) appended after. A deterministic
    // tiebreaker (convId,msgId) keeps the order stable across renders.
    if (sort === "recent") {
      scoped.sort((a, b) => b.ts - a.ts || (a.msgId < b.msgId ? -1 : 1))
    } else {
      scoped.sort((a, b) => {
        if (a.source !== b.source) return a.source === "substrate" ? -1 : 1
        if (a.source === "local") return b.ts - a.ts || (a.msgId < b.msgId ? -1 : 1)
        return 0
      })
    }

    // ---- BACKGROUND HYDRATE-ON-RENDER -------------------------------------
    // Fire-and-forget: substrate hits not yet in chat.db get their window fetched + upserted. The
    // existing `messages-upsert` WS delta reaches the open search view, which flips `hydrated:false`
    // rows in place. Never awaited — the response returns immediately. The hydrate engine's own
    // single-flight + page ceiling bounds the work; absence of an engine just means rows stay
    // `hydrated:false` until the next sweep picks the conv up.
    const hydrateEngine = deps.hydrates?.get(service)
    if (hydrateEngine) {
      const notHydrated = substrateProviderHits.filter(
        (ph) => !store.hasMessage(deps.db, service, ph.convId, ph.msgId),
      )
      if (notHydrated.length) void hydrateEngine.hydrateHits(notHydrated)
    }

    // cursor paging is deferred — substrate from/size chaining is a later increment. Returning null
    // is honest: the merged page is the best we have right now.
    return c.json({
      rows: scoped,
      parsed,
      cursor: null,
      total: scoped.length,
      ...(degraded ? { degraded } : {}),
    } satisfies SearchPage)
  })

  // ---- read state ----------------------------------------------------------

  // Read state is written THROUGH to the service (PSN-102): the provider write goes first, so a
  // failure surfaces as an error the client can revert on instead of the two silently diverging.
  // The local row is only touched once the service accepted the change.
  app.post("/mark-read", async (c) => {
    const b = await readBody(c)
    const { service, provider } = pick(deps, b.service)
    if (!b.convId) throw new ProviderError("missing_conv", 400)
    const ts = Number(b.ts) || 0
    await provider.markRead(b.convId, b.msgId ?? "", ts)
    store.markConversationRead(deps.db, service, b.convId, ts)
    return c.json({ ok: true })
  })

  app.post("/mark-unread", async (c) => {
    const b = await readBody(c)
    const { service, provider } = pick(deps, b.service)
    if (!b.convId) throw new ProviderError("missing_conv", 400)
    const ts = Number(b.ts) || 0
    await provider.markUnread(b.convId, ts)
    store.markConversationUnread(deps.db, service, b.convId, ts)
    return c.json({ ok: true })
  })

  // ---- backfill (WS-D engine; idle status when no engine is wired) --------

  // The live status PLUS the persisted run history (PSN-105 N) — the in-memory status dies with
  // the process, so past runs are only knowable from the store.
  app.get("/backfill", (c) => {
    const service = c.req.query("service") || DEFAULT_SERVICE
    const engine = deps.backfills?.get(service)
    return c.json({
      ...(engine ? engine.getBackfillStatus() : idleBackfill(service)),
      history: store.listBackfillRuns(deps.db, service),
    })
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

  // ---- build identity + sync diagnostics ----------------------------------

  app.get("/version", (c) =>
    c.json({
      version: ROOT_VERSION,
      // GIT_SHA is baked by the Docker builder; "unknown" in local dev is honest.
      sha: process.env.GIT_SHA || null,
      builtAt: process.env.BUILT_AT || new Date().toISOString(),
    }),
  )

  // No sweep engine wired = the server genuinely cannot answer, which is NOT the same thing as "no
  // events yet" (QE DEF-6: both rendered as an empty card, so the client's error state was dead
  // code and a broken server looked idle). A real status lets the client show its error branch.
  app.get("/sync-log", (c) => {
    const log = deps.getSyncLog?.()
    if (!log) throw new ProviderError("sync_unavailable", 502)
    return c.json(log)
  })

  return app
}

// Hono maps our numeric status onto its ContentfulStatusCode union; clamp to a safe error range.
// Exported so routes mounted OUTSIDE this router (the mock harness) map a ProviderError the same
// way instead of falling through to a bare 500 (QE DEF-8).
export function statusOf(n: number): 400 | 403 | 404 | 429 | 500 | 502 {
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

// A stored row → the ChatMessage the FE renders. The `raw` column keeps the original provider
// ChatMessage verbatim (decision 10) — use it whole (reactions/attachments intact); a raw-less row
// (direct DB writes in tests) reconstructs the renderable minimum from columns.
function toChatMessage(service: string, m: store.StoredMessage): ChatMessage {
  const raw = m.raw as ChatMessage | null
  if (raw && typeof raw === "object" && raw.id === m.id) return raw
  return {
    service: service as ChatMessage["service"],
    id: m.id,
    ts: m.ts ?? 0,
    senderId: m.senderId ?? undefined,
    senderName: m.senderName ?? undefined,
    body: m.body,
    edited: m.edited,
    deleted: m.deleted,
    mentionsMe: m.mentionsMe,
  }
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
