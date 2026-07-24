# Deploying the Chat BFF (PSN-93)

The BFF (`apps/chat-server`) runs as a **second process inside the existing single Dokploy
Application** at `portal.dp.dustin.one`. No new service, no new volume — the new entrypoint
starts both `chat-server` (background, `:7810`) and `web/server.mjs` (foreground, `:7800`)
inside the same container. `server.mjs` already reverse-proxies `/api/chat/*` and the WS
upgrade to `http://localhost:7810`.

> **Agent policy**: this agent does NOT touch Dokploy. All steps below are for the human.

Target: Dokploy Application `cdp-browser-app` (`RLo7fiU3_7tzBthG7OEV8`, appName
`cdp-browser-app-1yrpdy`) on the `dokploy-dell01` server, prod domain `portal.dp.dustin.one`,
previews `*.dp.dustin.one` (`previewPort=7800`, `previewLimit=10`).

---

## What changed in this PR

| File | Change |
|---|---|
| `apps/chat-server/src/index.ts` | DB path reads `CHAT_DB_PATH` → `DATA_DIR/chat.db` → `chat.db` |
| `docker-entrypoint.sh` | New shell entrypoint — starts both processes, exits container if either dies |
| `Dockerfile` | Copies `apps/chat-server` into runtime stage; adds BFF env defaults; switches from `CMD` to `ENTRYPOINT` |
| `docker-compose.yml` | Adds `CHAT_INTERNAL_SECRET`, `VAPID_*` passthrough vars |
| `.env.example` | Documents the new vars |

`chat.db` goes to `/data/chat.db` on the existing `cdp-web-data` volume — no new volume needed.

---

## Prod rollout

### 1. Environment variables

Application → **Environment** tab. Only **one** var is actually required:

```
CHAT_INTERNAL_SECRET=<openssl rand -hex 32>
```

Everything else the BFF needs (`DATA_DIR`, `CHAT_DB_PATH`, `CHAT_SERVER_PORT`, `CHAT_SERVER_URL`,
`TEAMS_UPSTREAM_URL`) is baked into the Dockerfile.

**Why it is required, not optional**: `/internal/teams/*` is served on the *public* origin
(`portal.dp.dustin.one/internal/teams/...`), guarded only by the `x-internal-secret` header. With
the var unset, both processes fall back to the literal `dev-internal-secret` — a value published in
this public repo. Anyone on the tailnet could then read and *send* Teams messages through the
origin. The tailnet is the only other gate.

**VAPID keys — leave them unset.** The guide previously said "copy the values already in Dokploy";
there are none. Both `web/server.mjs` and `apps/chat-server/src/index.ts` fall back to the *same*
hardcoded default keypair, which is what every already-installed PWA subscribed against. Setting
`VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` to anything different silently kills every existing
subscription. If you ever do want real keys, set the same trio on prod **and** in `previewEnv`, and
expect every device to re-subscribe once.

> 🔴 The default VAPID **private** key is committed in a public repo — anyone can push
> notifications to subscribed devices. Rotating is a deliberate, one-time push-loss event; track it
> separately from this rollout.

### 2. Volume — already correct, nothing to do

The Application already has mount `cdp-web-data → /data` (mountId `a5cBB6vNcS0GH0UfGi3hA`,
verified 2026-07-25). `CHAT_DB_PATH=/data/chat.db` lands on it, so `chat.db` survives redeploys.
Do **not** deploy with an empty mounts list — that is what wiped labels/folders/push-subs before.

### 3. Redeploy

Trigger **Redeploy**. The image builds both processes and boots via `docker-entrypoint.sh`.

### 4. Verify

Container logs should show two startup lines:

```
chat-server listening on :7810
Web server listening on :7800   (or similar)
```

Then, from a tailnet-connected machine:

```sh
# BFF alive through the server.mjs proxy (GET, harmless)
curl https://portal.dp.dustin.one/api/chat/push/vapid-public-key
# → {"key":"BDIDtkQn…"}   (a 502 {"error":"chat_upstream_unreachable"} means the BFF is down)

curl -o /dev/null -w '%{http_code}\n' https://portal.dp.dustin.one/api/chat/prefs   # → 200

# WS push path (must answer 101, not 404 — needs --http1.1; over h2 curl won't upgrade)
curl -sI --http1.1 -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  https://portal.dp.dustin.one/api/chat/ws | head -1
# → HTTP/1.1 101 Switching Protocols

# Commit actually deployed
curl https://portal.dp.dustin.one/api/version
```

There is **no** `/api/chat/health`: the BFF's health route is `/health`, which is not proxied
(`server.mjs` only forwards `/api/chat/*`). `/api/chat/conversations` is a **POST**, not a GET.

If the BFF fails to start, the container exits and Dokploy restarts it (the watchdog in
`docker-entrypoint.sh` kills `server.mjs` when `chat-server` dies, so both restart cleanly).

---

## Preview deployments

Previews are the same image on `preview-cdp-browser-app-1yrpdy-<id>.dp.dustin.one`. Three things
differ from prod and all three bite.

### 1. `previewEnv` does NOT inherit the Application env

Dokploy keeps a separate **Preview Deployments → Environment** block. It currently carries only
`CDP_HOST`, `CDP_PORT`, `PORT`, `APP_TITLE`. Add there too:

```
CHAT_INTERNAL_SECRET=<same value as prod, or a second random one>
```

Without it every preview URL exposes `/internal/teams/*` behind the published default secret.
Existing previews must be redeployed to pick the var up — it is not applied retroactively.

### 2. The `/data` volume may be shared with prod — check before merging

The Application-level mount is `cdp-web-data`. Dokploy is supposed to suffix named volumes per
preview (`cdp-web-data-<suffix>`), but on 2026-07-25 prod and the PSN-93 preview returned
**byte-identical** `/api/notifications` (51 615 bytes) — consistent with both mounting the *same*
volume. If that is what is happening, a preview's `chat-server` writes prod's `chat.db`: two
always-on sweeps on one SQLite file, and a preview branch's schema migration running against prod
data.

Confirm with one write on a preview and one read on prod (pins are empty on both, and it is
reversible):

```sh
PREVIEW=https://preview-cdp-browser-app-1yrpdy-<id>.dp.dustin.one
curl -s -X POST "$PREVIEW/api/pins/add" -H 'content-type: application/json' \
  -d '{"title":"vol-probe","url":"https://example.com"}'
curl -s https://portal.dp.dustin.one/api/pins        # [] = isolated · shows vol-probe = SHARED
curl -s -X POST "$PREVIEW/api/pins/remove" -H 'content-type: application/json' -d '{"id":"<id>"}'
```

If shared: give previews their own storage before enabling the BFF on them — e.g. set
`CHAT_DB_PATH=/data/preview-chat.db` in `previewEnv` as a stopgap (separate file, same volume), or
switch the mount so previews get their own named volume.

### 3. One browser, one Teams session

Every preview container runs its **own always-on ~12 s Teams sweep** against the single `glkvm`
browser that prod also drives. Two live previews plus prod = three sweepers competing for one CDP
session. Keep at most one preview open at a time, and close the PR (or stop the preview) when the
review is done.

A fresh preview starts with an empty `chat.db` (assuming isolation is fixed). Populate it from
`/chat` → Settings → Data → pick a backfill window → Run; the sweep keeps it live after that.

Push subscriptions are origin-bound, so a preview never steals prod's notifications — but the
device has to grant push again per preview origin.

---

## Rollback

Roll back to the previous image tag in Dokploy. The `/data` volume is unchanged — adding `chat.db`
is additive and the old image ignores it.
