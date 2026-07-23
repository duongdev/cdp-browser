# 127 — teams chat app: cred mint + sqlite store + conversation-list read

- **Status:** done
- **Mode:** HITL
- **Estimate:** 1d
- **Depends on:** none (runtime: a live Teams tab on the remote CDP browser for cred extraction)
- **Blocks:** t128+ (the whole Teams Chat App epic — see roadmap below)

## Goal

Stand up the **data-layer foundation** for a standalone Teams chat app: the backend can
mint Teams messaging creds from a live Teams tab, persist chat state in its own SQLite
DB, and serve an authenticated conversation list. After this ships, `GET
/api/teams/conversations` returns the real Teams conversation list (1:1 + group chats,
each with its `lastMessage` preview) minted through the keeper tab and upserted into the
chat DB — the base every downstream task reads from. No UI, no message read/reply yet.

This is Ring-1 of an epic (a separate chat app that shares this repo's extended
backend). This task delivers the cred + store + list-read spine and records the epic's
architecture as **ADR-0019**. It is backend-only and curl-verified.

## Why now

Everything in the epic (list UI, message read/render, reply, rich compose, sweep, push)
depends on two unproven-in-code pieces: (1) the Teams cred mint chain and (2) a real
chat DB. Both are the risk. Proving them end-to-end first (curl → real conversations in
SQLite) de-risks the whole bet before any UI cost is spent. The msg API round-trip
(mint → authz → conversations → messages → send → delete) is already **proven live**
against the remote instance; this task lands the first two rungs in code.

## Locked decisions (grilled — the epic's decision ledger; ADR-0019 records these)

1. **Structure:** new `chat/` dir (Vite web app + thin Electron shell that loads the URL)
   served by the *extended* `web/server.mjs`; `core/` shared directly; pnpm monorepo
   **deferred** (ADR-0008's named "third surface" trigger — take the lazy split, not the
   full restructure).
2. **DB:** server-owned **SQLite (`better-sqlite3`)** = single source of truth; clients
   keep a light cache and sync via the existing SSE/WS (mirrors ADR-0017 pins/history).
   Electron is a shell → no native-module bundling.
3. **Auth:** **keeper tab** on the remote browser mints creds; cred module built behind a
   clean interface so **off-box** auth can slot in later without rework.
4. **Ingestion:** **poll-first** — global sweep + faster poll on the focused conversation +
   the existing Teams toast-capture demoted to a "sweep now" trigger. **Trouter = v2**
   (URL recorded now, unused).
5. **v1 scope:** **chats only** (1:1 + group DMs) — read + **rich compose** (reactions,
   edit/delete own, attachments). **No channels.**
6. **Render:** **full fidelity** — sanitized HTML + **adaptive cards** (reuse Microsoft's
   `adaptivecards` renderer; cards degrade to a chip until that task lands). Never
   `innerHTML` raw content.
7. **Push:** **unified** — chat ingestion drives web push; a Teams ping deep-links into
   the chat app conversation (reuses the existing VAPID/SW/subscription spine).
8. **Backfill:** **hybrid** — eager recent-N per conversation (previews + light search),
   lazy backward paging on scroll for depth. DB persists per-conversation newest + oldest
   cursors, both resumable.
9. **Read state:** **hybrid** — local read on open; write-through Teams `consumptionHorizon`
   only on reply / explicit mark-read.
10. **Edit/delete:** **full reconcile + markers** — poll reconciles by `(id, version)` via
    `lastUpdatedMessageVersion`; edit → update + "(edited)"; delete → tombstoned row
    rendered "message deleted".
11. **Accounts:** **single** signed-in identity for v1 (covers the whole Enterprise Grid
    org), creds + DB **keyed by tenant** so a multi-account switcher slots in later.
12. **Deploy:** **same origin, path** (e.g. `<host>/chat`) — path-scoped service worker;
    shared origin eases the unified push subscription.

Deferred defaults: search = later (DB FTS-ready), offline read = later, typing/presence =
later, layout = two-pane wide / stacked phone, working name "Teams Chat".

## Proven API facts (pin these; they cost real time to rediscover)

- **Mint chain:** read the plaintext MSAL access token for audience
  `api.spaces.skype.com` (Teams web client id `5e3ce6c0-2b1f-4285-8d4b-75ee78787346`;
  value is JSON, `.secret` = the bearer JWT, `.expiresOn` = epoch secs) →
  `POST https://teams.microsoft.com/api/authsvc/v1.0/authz` with `Authorization: Bearer
  <that>` → `200 { tokens.skypeToken, regionGtms }`.
- **Bases:** `chatServiceBase = regionGtms.chatService` (e.g.
  `https://apac.ng.msg.teams.microsoft.com`); `trouterUrl = regionGtms.calling_trouterUrl`
  (record now, unused v1).
- **Msg-service auth header:** `Authentication: skypetoken=<skypeToken>` — **not**
  `Authorization: Bearer`, not a form token.
- **Conversations:** `GET {chatServiceBase}/v1/users/ME/conversations?view=msnp24Equivalent&pageSize=N&startTime=1`
  → `{ conversations[], _metadata }`. Each conv: `id, lastMessage, messages,
  lastUpdatedMessageId, lastUpdatedMessageVersion, properties, threadProperties,
  memberProperties`. Filter reserved `48:*` (`48:notes` self-chat, `48:notifications`,
  `48:mentions`). 1:1 ids end `@unq.gbl.spaces`.
- **`chatsvcagg.teams.microsoft.com` is a proven 401 dead-end** — the bearer authenticates
  but the request is unauthorized there. Pin ALL traffic to `chatServiceBase`. Guard with
  a loud comment.
- **Refresh:** a 401 on the msg service triggers **re-authz (re-mint)**, not a re-scrape.
  The ~1h bearer is rotated only by the live Teams tab's MSAL (refresh token is
  AES-encrypted, un-scrapable) → the **keeper tab is load-bearing** in a way Slack's
  session token never was. `markCredsStale` re-extracts the bearer from a live tab, then
  re-authz.
- **Web-only:** Electron has no scrapable creds path → the `/api/teams/*` surface is web
  build only; Electron structurally stubs (absent bridge methods), same pattern as the
  Slack sweep.
- **CA-proof in-page execution (decided up front):** unlike the Slack sweep (which calls
  Slack's API server-side directly), **all** Teams HTTPS calls — the `authz` mint AND the
  conversations fetch — run **in-page inside the Teams tab** via the side-channel
  `Runtime.evaluate` (the browser makes its own authenticated `fetch`; the server only
  orchestrates + persists the returned JSON). This originates every call from the
  browser's session + egress IP, so a Conditional-Access policy binding tokens to the
  compliant device/IP can't reject them. It also means the skype token never leaves the
  browser unless the in-page script returns it — for v1 the record still stores
  `skypeToken`/`bearer` server-side (needed for the Ring-2 sweep + future off-box), but the
  live fetches don't depend on it leaving. Mirrors exactly how feasibility was proven.

## Acceptance criteria

- [ ] `core/teams-creds.js` (pure) parses the MSAL bearer for client id
      `5e3ce6c0-…` from a localStorage snapshot → `{ bearer, bearerExp }`; returns null on
      missing/malformed; `markFresh`/`markStale`/`redact` mirror the `slack-creds` shape.
- [ ] The `teams` adapter in the side-channel gains cred extraction (`extractCreds`): its
      read-only socket runs `Runtime.evaluate` to read the MSAL bearer **and run the
      `authz` POST in-page** (CA-proof), returning `{ skypeToken, chatServiceBase,
      trouterUrl, userId, tenant, bearerExp }`; a **`credsByTenant`** record is stored:
      `{ tenant, userId, bearer, bearerExp, skypeToken, chatServiceBase, trouterUrl,
      fresh, lastError }` with `onCreds` / `markCredsStale` / `getCreds(tenant)` accessors
      (parallel to Slack's `credsByTeam` — NOT genericized).
- [ ] `core/teams-store.js` opens/migrates a SQLite DB (DI `better-sqlite3` handle) with
      the schema below; migration is idempotent; `upsertConversations` inserts new,
      updates by `lastUpdatedMessageVersion`, and skips reserved `48:*`/self convs.
- [ ] `GET /api/teams/conversations` mints/reuses creds via `getCreds(tenant)`, fetches
      `{chatServiceBase}/v1/users/ME/conversations` **in-page via the side-channel**
      (not server-side direct — CA-proof), filters reserved/self, upserts into the DB, and
      returns the conversation list (id, kind, topic, lastMessage preview).
- [ ] A stale bearer (forced) drives a single **re-authz** (not a re-scrape) and the
      request recovers; a hard-expired session returns a typed `invalid_auth`.
- [ ] `docs/adr/0019-teams-chat-app.md` (Proposed) records the architecture + the 12
      decisions + the pinned trap-facts.
- [ ] `better-sqlite3` added to `dependencies`; server boots (`node --check web/server.mjs`
      + a real boot) with the new route.

## Test plan

### Layer 1 — Pure logic (TDD)

- [ ] `teams-creds.parseMsalBearer` — finds the client-id accesstoken entry; ignores
      other-audience entries; missing entry → null; malformed JSON → null; `expiresOn`
      parsed to `bearerExp`.
- [ ] `teams-creds.markFresh/markStale/redact` — state transitions; `redact` never leaks
      the bearer/skypeToken.
- [ ] `teams-store` (against an in-memory `:memory:` handle) — migration idempotent
      (run twice, no error); `upsertConversations` inserts new, updates a row when
      `lastUpdatedMessageVersion` rises, no-ops on equal version, filters `48:*`/self;
      newest/oldest cursor columns initialize.

### Layer 2 — Manual smoke (CDP/IPC)

With a live Teams tab on the remote browser (the keeper) and `pnpm web:serve`:

- [ ] `curl http://localhost:<port>/api/teams/conversations` → 200, a JSON list of real
      conversations (1:1 + group), no `48:*` entries.
- [ ] Inspect the SQLite file — `conversations` rows present with `last_message_*` set.
- [ ] Force a stale bearer (e.g. clear the record's `fresh`) → next request re-authz's and
      still returns 200.

### Layer 3 — Visual review

n/a — this task touches no renderer UI (backend-only; UI is t128+).

## Design notes

- **Contracts changed:** side-channel gains a **`credsByTenant`** map + `TeamsCredsRecord`
  (`{ tenant, userId, bearer, bearerExp, skypeToken, chatServiceBase, trouterUrl, fresh,
  lastError }`) alongside the existing Slack `credsByTeam` — kept as **two parallel
  impls**, not one leaky generic (the module already special-cases Slack throughout).
- **New modules:**
  - `core/teams-creds.js` — pure MSAL-bearer parse + fresh/stale/redact (mirrors
    `slack-creds.js` shape).
  - `core/teams-store.js` — SQLite chat store (DI handle), schema + migrations + upserts.
  - New route `GET /api/teams/conversations` in `web/server.mjs`.
- **New ADR needed?** yes — `0019-teams-chat-app.md` (Proposed): standalone chat app +
  shared extended backend + server-owned SQLite + poll-first ingestion + unified push;
  pins the trap-facts + the 12 decisions.

```ts
// The cred record the side-channel stores per tenant (mirror of the Slack shape):
interface TeamsCredsRecord {
  tenant: string          // AAD tenant id
  userId: string          // AAD object id
  bearer: string          // api.spaces.skype.com access token (.secret), ~1h
  bearerExp: number       // epoch secs
  skypeToken: string      // minted via authz; auths the msg service
  chatServiceBase: string // regionGtms.chatService — ALL msg traffic pins here
  trouterUrl: string      // regionGtms.calling_trouterUrl — recorded, unused in v1
  fresh: boolean
  lastError: string | null
}
```

SQLite schema (this task creates all tables + FTS; only `accounts` + `conversations` are
written here — `messages`/`read_state` land in t129+, but the schema + migration ship now so
later tasks don't migrate):

```sql
accounts(tenant PK, user_id, display_name, chat_service_base, updated_at)
conversations(id PK, tenant, kind, topic, last_message_id, last_message_version,
              last_message_ts, last_message_preview, newest_synced_ts, oldest_synced_ts,
              muted, updated_at)
messages(conv_id, id, tenant, version, sender_id, sender_name, ts, content,
         deleted INTEGER, edited INTEGER, PRIMARY KEY(conv_id, id))   -- written t129+
read_state(conv_id PK, tenant, read_horizon_ts, local_read_ts)        -- written t130+
messages_fts USING fts5(content, content='messages')                  -- populated later
```

## Out of scope (each is its own downstream task)

- Message read / render / thread view (t129) and `teams-render.js` (HTML sanitize +
  adaptive cards).
- Text reply (t130); rich compose — reactions, edit/delete, attachments (t132–t133).
- Poll sweep + watermark + client SSE/WS sync + `clientmessageid` echo-dedup +
  edit/delete reconcile (t131).
- Eager recent-N backfill + lazy backward paging (with message read, t129).
- The `chat/` app shell (Vite entry + thin Electron main + served `/chat` route) + list UI
  (t128).
- Unified web push routing into the chat app (t135).
- `consumptionHorizon` write-through mark-read (t130/t131).
- Trouter realtime (t136, v2); Slack on the same surface; off-box auth.

## Definition of Done

- [ ] Layer 1 tests written and green (`teams-creds`, `teams-store`).
- [ ] Layer 2 smoke checklist completed against a live Teams keeper tab.
- [ ] Layer 3 — n/a (no UI).
- [ ] `pnpm check` clean (files touched only).
- [ ] `pnpm typecheck` clean.
- [ ] `pnpm test` green.
- [ ] `node --check web/server.mjs` + a real boot with the new route serving.
- [ ] CLAUDE.md updated for the new `core/teams-creds.js` + `core/teams-store.js` modules
      and the `/api/teams/conversations` route.
- [ ] ADR-0019 written (Proposed).
- [ ] No commented-out code, no `console.log` debris, no AI attribution.
- [ ] Task closed: status → done, file moved to `docs/tasks/done/`, `t127` in commit.

## Roadmap (the epic — split/renumber during execution)

- **t127 (this):** cred mint + SQLite store + conversation-list read + ADR-0019.
- t128: `chat/` app shell (Vite + thin Electron shell + `/chat` route) + conversation-list UI reading the DB.
- t129: message read + `teams-render.js` (sanitized HTML) + thread view + recent-N backfill + lazy scroll-back.
- t130: text reply (optimistic + honest fail) + `consumptionHorizon` write-through on send.
- t131: poll ingestion (fast-on-open + toast trigger) + DB writes + edit/delete reconcile + client SSE/WS sync + `clientmessageid` dedup.
- t132: reactions + edit/delete own messages.
- t133: attachments (AMS upload flow).
- t134: adaptive-card rendering (`adaptivecards` lib).
- t135: unified web push — Teams ingestion → push → deep-link into the chat app.
- t136+ (v2): trouter realtime; then Slack on the same surface; then off-box auth.

## Notes

- Feasibility is **proven live** (2026-07-21): full mint → list → read → send → delete
  round-trip against the remote instance; send+delete verified on the self-chat
  (`48:notes`) and cleaned up. See the `teams-native-client-feasibility` project memory.
- The keeper tab is load-bearing (unlike Slack). Ring-1 can lean on the user's own
  live/pinned Teams tab; a dedicated parked keeper (mirroring the Slack keeper t070/t098,
  deferring to a pin) is a Ring-2 hardening task.
- Conditional-Access: **resolved up front** — all Teams calls run in-page via the
  side-channel (see the CA-proof bullet in Proven API facts), so server egress IP is never
  the token's origin. The `teams-api` client (t128) is therefore a **side-channel-driven**
  client (an in-page `fetch` executor over `Runtime.evaluate` returning JSON), NOT a node
  `fetch` client like `slack-api.js`. This is the one structural divergence from the Slack
  stack; carry it forward through the whole epic.
