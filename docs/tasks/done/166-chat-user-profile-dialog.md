# t166 — User profile dialog

Status: done
Scope: `/chat` + `web/server.mjs`. The `/` browser build is byte-unchanged.
Plan: PSN-95 workstream C.

## What shipped

- **Server** (`web/server.mjs`): `GET /api/teams/profile?userId=` — in-page Graph
  `GET /v1.0/users/{oid}?$select=displayName,mail,userPrincipalName,jobTitle,
  department,officeLocation,businessPhones,mobilePhone` using the page's own MSAL
  bearer (same CA-proof pattern as the avatar/getByIds paths). `userId`
  shape-guarded by `teamsNormalizeUserOid` (SSRF). LRU cache (256) — reopening is
  instant, Graph isn't re-hit; errors are never cached so a transient no-tab
  doesn't stick. Typed errors: `invalid_auth` 401 / `not_found` 404 / else 502.
- **Client** (`chat/src/lib/teams-client.ts`): `TeamsProfile` + `fetchProfile`
  (throws `TeamsApiError`).
- **Dialog** (`chat/src/components/profile-dialog.tsx`): shadcn Dialog — large
  `UserAvatar`, display name (known name renders instantly while the card loads),
  job title, then labelled rows (email `mailto:`, department, office, phones).
  Loading skeleton / typed error copy / "No directory details available" empty
  state. A **Message** button opens the existing 1:1 (resolved in `chat-app.tsx`
  by matching the profile oid against each `oneOnOne` row's `avatarUserId`);
  hidden when no DM exists (never creates a conversation — grill Q11 scope).
- **Wiring**: the sender name+avatar header on every non-self message row is now a
  button (`message-row.tsx` → `thread-view.tsx` pass-through → one `ProfileDialog`
  hosted in `chat-app.tsx`). Layout unchanged when not clickable (no senderId).

## Verification

- `vitest run chat/src` — 197 pass. `tsc --noEmit` clean. Biome exit 0 on all
  touched files. `node --check web/server.mjs` OK. `pnpm chat:build` succeeds.
- Live: field coverage depends on the tenant directory — verified in the G sweep.

## Known ceilings / carry-overs

- Presence not shown (separate Graph API + scope; grill said best-effort — probe
  during G; skipped if the bearer lacks the scope).
- Profile cache is server-memory (LRU), not the `users` table — restarts refetch.
  Upgrade path: persist rows in `users` if restarts prove annoying.
- Group-chat rows/headers aren't profile-clickable (only message sender headers);
  the facepile has no per-member hit target.
