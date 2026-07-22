# ADR-0019: Teams chat app — standalone surface on a shared extended backend

- **Status:** Proposed
- **Date:** 2026-07-21

## Context

The notification stack already captures Teams toasts (ADR-0003) and Slack messages via
a server-side content sweep (ADR-0011). The next step is a **standalone Microsoft Teams
chat app** — read + reply to 1:1 and group chats natively, not through the screencast.
This is an epic (Ring-1 lands the data spine; UI, message read/render, reply, rich
compose, sweep, and push follow). Two pieces were unproven in code and carry all the risk:
(1) the Teams messaging-cred **mint chain**, and (2) a real server-owned **chat store**.
Both were proven **live** (2026-07-21: full mint → list → read → send → delete round-trip
against the remote instance) before this ADR; the task lands the first two rungs in code.

Constraints that shaped the design:

- **Conditional Access (CA).** Teams tokens can be bound to a compliant device / IP. A
  server that calls Teams' API directly (like the Slack sweep does) would originate from
  the server's egress IP and be rejected. This is the one structural divergence from the
  Slack stack.
- **Un-scrapable refresh.** The ~1h `api.spaces.skype.com` bearer is rotated only by the
  live Teams tab's MSAL (its refresh token is AES-encrypted, un-scrapable). So the **keeper
  tab is load-bearing** in a way Slack's static session token never was.
- **Electron has no creds path.** As with the Slack sweep, only the web build can mint —
  Electron structurally stubs (`/api/teams/*` is web-only).

## Decision

Build a standalone chat app (`chat/`, working name "Teams Chat") served by the *extended*
`web/server.mjs`, sharing `core/` directly. The backend owns a **SQLite** chat store; all
Teams HTTPS traffic runs **in-page** through the keeper tab; ingestion is **poll-first**;
push is **unified** with the existing VAPID/SW spine.

The epic's decision ledger (grilled — these are the locked decisions ADR-0019 records):

1. **Structure.** New `chat/` dir (Vite web app + a thin Electron shell that loads the URL)
   served by the extended `web/server.mjs`; `core/` shared directly. **pnpm monorepo
   deferred** — this is ADR-0008's named "third surface" trigger, but we take the lazy split,
   not the full restructure, until it actually hurts.
2. **DB.** Server-owned **SQLite (`better-sqlite3`)** is the single source of truth; clients
   keep a light cache and sync over the existing SSE/WS (mirrors ADR-0017 pins/history).
   Electron is a shell → no native-module bundling (not in `package.json` `build.files`).
3. **Auth.** The **keeper tab** on the remote browser mints creds. The cred module sits
   behind a clean interface so **off-box** auth can slot in later without rework.
4. **Ingestion.** **Poll-first** — a global sweep + a faster poll on the focused
   conversation; the existing Teams toast-capture is demoted to a "sweep now" trigger.
   **Trouter = v2** (its URL is recorded now, unused).
5. **v1 scope.** **Chats only** (1:1 + group DMs) — read + **rich compose** (reactions,
   edit/delete own, attachments). **No channels.**
6. **Render.** **Full fidelity** — sanitized HTML + **adaptive cards** (reuse Microsoft's
   `adaptivecards` renderer; cards degrade to a chip until that task lands). Never
   `innerHTML` raw content.
7. **Push.** **Unified** — chat ingestion drives web push; a Teams ping deep-links into the
   chat app conversation, reusing the existing VAPID/SW/subscription spine (ADR-0013/0014).
8. **Backfill.** **Hybrid** — eager recent-N per conversation (previews + light search),
   lazy backward paging on scroll for depth. The DB persists per-conversation **newest +
   oldest cursors**, both resumable across restarts.
9. **Read state.** **Hybrid** — local read on open; write-through Teams `consumptionHorizon`
   only on reply / explicit mark-read.
10. **Edit/delete.** **Full reconcile + markers** — the poll reconciles by `(id, version)`
    via `lastUpdatedMessageVersion`; edit → update + "(edited)"; delete → tombstoned row
    rendered "message deleted".
11. **Accounts.** **Single** signed-in identity for v1 (covers the whole Enterprise Grid
    org); creds + DB are **keyed by tenant** so a multi-account switcher slots in later.
12. **Deploy.** **Same origin, path** (e.g. `<host>/chat`) — a path-scoped service worker;
    a shared origin eases the unified push subscription.

Deferred defaults: search = later (the DB is FTS-ready), offline read = later,
typing/presence = later, layout = two-pane wide / stacked phone.

### CA-proof in-page execution (decided up front — the structural divergence)

Unlike the Slack sweep (which calls Slack's API server-side directly), **all** Teams HTTPS
calls — the `authz` mint **and** the conversations/messages fetches — run **in-page inside
the Teams tab** via the side-channel `Runtime.evaluate` (the browser makes its own
authenticated `fetch`; the server only orchestrates + persists the returned JSON). Every
call therefore originates from the browser's session + egress IP, so a CA policy binding
tokens to the compliant device/IP can't reject them. Consequently the `teams-api` client
(t128) is a **side-channel-driven** client (an in-page `fetch` executor over
`Runtime.evaluate` returning JSON), **not** a Node `fetch` client like `slack-api.js`. This
divergence carries forward through the whole epic.

The skype token still leaves the browser and is stored server-side for v1 (needed for the
Ring-2 sweep + future off-box auth), but the **live fetches never depend on it leaving** —
they run where the token was minted.

### What Ring-1 (t127) actually lands

- `core/teams-creds.js` (pure): `parseMsalBearer(localStorageSnapshot)` finds the
  `api.spaces.skype.com` accesstoken entry (key `msal.` + `accesstoken` + the audience) →
  `{ bearer, bearerExp }`; `decodeJwtClaims` derives `tid`/`oid`; `markFresh`/`markStale`/
  `redact` mirror `slack-creds.js`. A parallel impl, not a genericization of Slack's.
- The side-channel gains a **Teams cred path** (`credsByTenant`, parallel to Slack's
  `credsByTeam`): its read-only socket dumps the MSAL entries, the server parses the bearer,
  and the `authz` POST runs **in-page**; the record is
  `{ tenant, userId, bearer, bearerExp, skypeToken, chatServiceBase, trouterUrl, fresh,
  lastError }`, exposed via `onTeamsCreds` / `getTeamsCreds(tenant)` / `markTeamsCredsStale`
  (re-mint over the live tab) / `runInTeamsPage` (in-page fetch executor).
- `core/teams-store.js` (DI `better-sqlite3` handle): creates + idempotently migrates the
  whole schema (accounts, conversations, messages, read_state, messages_fts); t127 writes
  only `accounts` + `conversations` (`upsertConversations` version-gates by
  `lastUpdatedMessageVersion` and skips reserved `48:*`/self).
- `GET /api/teams/conversations`: mints/reuses creds, fetches conversations **in-page**,
  upserts, returns the DB view. A 401 in-page drives a single re-authz (re-mint) + one
  retry, then a typed `invalid_auth`.

### Pinned trap-facts (they cost real time to rediscover)

- **Mint chain:** MSAL `api.spaces.skype.com` accesstoken (Teams web client id
  `5e3ce6c0-2b1f-4285-8d4b-75ee78787346`; `.secret` = bearer JWT, `.expiresOn` = epoch secs)
  → `POST https://teams.microsoft.com/api/authsvc/v1.0/authz` with `Authorization: Bearer …`,
  body `"{}"` → `200 { tokens.skypeToken, regionGtms }`.
- **Msg-service auth header** is `Authentication: skypetoken=<t>` — **not**
  `Authorization: Bearer`, not a form token.
- **`chatsvcagg.teams.microsoft.com` is a proven 401 dead-end** — the bearer authenticates
  but the request is unauthorized there. Pin **all** traffic to
  `chatServiceBase = regionGtms.chatService` (e.g. `https://apac.ng.msg.teams.microsoft.com`).
- **Conversations:** `GET {chatServiceBase}/v1/users/ME/conversations?view=msnp24Equivalent&
  pageSize=N&startTime=1`. Filter reserved `48:*` (`48:notes` self, `48:notifications`,
  `48:mentions`); 1:1 ids end `@unq.gbl.spaces`.
- **Refresh:** a 401 on the msg service triggers **re-authz (re-mint)**, not a re-scrape —
  the bearer is rotated only by the live tab's MSAL. `markCredsStale` re-reads + re-authz's.

## Consequences

- Easier: the risky pieces (mint chain + chat DB) are proven end-to-end in code before any
  UI spend; downstream tasks read from a stable DB and a stable cred interface. CA is
  resolved up front, so no epic-wide rework when a policy tightens.
- Harder: the **keeper tab is load-bearing** — with no live Teams tab, creds can't be minted
  and the surface degrades (a dedicated parked keeper mirroring the Slack keeper is a Ring-2
  hardening task). SQLite adds a **native module** the web server must build (approved in
  `pnpm-workspace.yaml`); it must never be pulled into the Electron package.
- Two parallel cred impls (Slack `credsByTeam` + Teams `credsByTenant`) live in the
  side-channel by choice — the mint chains genuinely differ, and a leaky shared generic would
  cost more than the duplication saves.

## Alternatives

- **Server-side Teams API client (like `slack-api.js`).** Rejected: server egress IP is not
  the token's origin, so Conditional Access rejects it. In-page execution is the only path
  that survives CA.
- **One generic cred module for Slack + Teams.** Rejected: the mint chains diverge (static
  session token vs MSAL-bearer→authz-skypetoken with keeper-driven rotation); a shared
  abstraction would special-case both throughout.
- **A JSON file store (like notifications/history).** Rejected: chat needs indexed queries,
  per-conversation cursors, edit/delete reconcile, and future FTS — SQLite is the right tool;
  a growing JSON blob is not.
- **pnpm monorepo now.** Deferred (ADR-0008): the lazy `chat/` split covers the third
  surface until shared build tooling actually hurts.
- **Trouter realtime for ingestion.** Deferred to v2: poll-first is simpler and reuses the
  existing reconcile cadence; Trouter's URL is recorded now for when realtime is worth it.
