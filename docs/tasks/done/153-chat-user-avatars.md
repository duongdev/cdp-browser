# t153 — Chat user avatars (Workstream E)

Status: done · web only · ADR-0019 · PSN-90 plan Workstream E

## Goal

Real participant/sender photos in the `/chat` Teams app, replacing initial-letter
tiles. Graceful fallback to initials on any miss. No layout shift. Threading is
**out** (decided flat, grill #5) — avatars are the whole scope.

## Feasibility probe (done first, live)

Tested Microsoft Graph `GET /v1.0/users/{oid}/photos/48x48/$value` **in-page**
(CA-proof `runInTeamsPage`) with the **existing messaging Graph bearer** — the same
MSAL `accesstoken` scoped to `graph.microsoft.com` that t131's `getByIds` reads
from `localStorage`. Binary read via `fetch → blob → FileReader` data URL (mirrors
`/api/teams/media`).

**Result: PASS.** No extra scope needed.
- `57e304ce-…` (Haiyang Zhao) → real `48x48` JPEG, 1649 bytes. Rendered live.
- `623d9d09-…` (self), `441de7d0-…` → `404` (no photo) → negative-cached, 204 to client.
- `?userId=https://evil.com/x` → `400` (SSRF shape guard).

## Approach

**Server (`web/server.mjs`)** — `GET /api/teams/avatar?userId=…`:
- SSRF/shape guard: `userId` normalized by `teamsNormalizeUserOid` (new, pure, in
  `core/teams-names.js`) — strips an `8:orgid:` prefix, accepts **only a bare UUID**,
  never a URL. Reject → `400`.
- In-page Graph photo fetch (`fetchTeamsAvatarInPage`) → `teamsAvatar` decodes the
  data URL to bytes. `404` → `{ miss: true }` → `204` (client keeps initials).
- Serves bytes with `Content-Type` (image-only guard), `X-Content-Type-Options:
  nosniff`, `Cache-Control: public, max-age=86400`.
- `avatarUserId` added per conversation in `teamsResolveTitles`: self → `cred.userId`,
  1:1 → the other member's oid (from the already-derived `mrisByConv`), group →
  undefined (keeps the initials tile).

**Client (`chat/`)** — `UserAvatar` component (`user-avatar.tsx`):
- Initials tile always renders behind; the `<img>` (`/api/teams/avatar?userId=…`)
  is absolutely positioned on top, same fixed box → **zero layout shift**. `onError`
  (fires on 204/404/502 — no decodable body) reverts to initials.
- Conversation rows: `conversation-row.tsx` uses `conversation.avatarUserId`.
- Message sender: `message-row.tsx` shows a `size-5` avatar next to the sender name
  for **other-people's** messages in a thread (via `message.senderId`). Own messages
  (right-aligned, no name) get none — clean, uncluttered.

## Cache design

`TEAMS_AVATAR_CACHE` — `Map<oid, { ct, buf } | { miss: true }>`, LRU (re-insert on
get, evict oldest past `TEAMS_AVATAR_CACHE_MAX = 256`). **Negative caching**: a 404
(no photo, common) is stored as `{ miss: true }` so a list of many photo-less users
can't hammer Graph. Keyed by the immutable bare oid. Mirrors the t139 media cache.

## Acceptance

- [x] Feasibility probe passed live (real JPEG returned with existing Graph bearer).
- [x] Sender + conversation avatars load real photos (proxied, cached, SSRF-guarded).
- [x] Graceful fallback to initials on any miss (204/error → onError → initials).
- [x] No layout shift; avatars reserve their box (initials behind, img on top).
- [x] `pnpm test` (1422 pass, incl. new `normalizeUserOid` SSRF tests), `pnpm
      typecheck`, `pnpm chat:build` all clean; `node --check web/server.mjs` ok.
- [x] Diff confined to `web/server.mjs` + `core/**` + `chat/**` + `docs/tasks/**`.

## Verification

- `pnpm test` — 120 files / 1422 tests pass (added `normalizeUserOid` cases).
- `pnpm typecheck` — clean. `pnpm chat:build` — clean.
- Live screenshots: list at `/tmp/psn90-avatars-list.png`; a 1:1 thread with a real
  sender photo at `/tmp/psn90-thread-avatar.png` (Haiyang Zhao's photo renders next
  to each of their message rows; photo-less users keep initials).

## Notes / decisions

- Message-sender avatar included (small, left of the name for others only) — it reads
  clean and matches Teams/Slack. Skipped for own messages (right-aligned, nameless).
- Group-chat conversation rows keep the initials tile (no single representative user;
  a 2-photo stack was not trivial — deferred).
- Media/photo bytes ride plaintext even in E2E mode (an `<img src>` can't decrypt a
  sealed body) — the documented t139 tradeoff applies unchanged.
