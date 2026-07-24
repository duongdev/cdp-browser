# Deploying the Chat BFF (PSN-93)

The BFF (`apps/chat-server`) runs as a **second process inside the existing single Dokploy
Application** at `portal.dp.dustin.one`. No new service, no new volume — the new entrypoint
starts both `chat-server` (background, `:7810`) and `web/server.mjs` (foreground, `:7800`)
inside the same container. `server.mjs` already reverse-proxies `/api/chat/*` and the WS
upgrade to `http://localhost:7810`.

> **Agent policy**: this agent does NOT touch Dokploy. All steps below are for the human.

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

## Steps to roll out on Dokploy

### 1. Add environment variables

In the Dokploy Application → **Environment** tab, add:

```
CHAT_INTERNAL_SECRET=<generate: openssl rand -hex 32>
```

```
VAPID_PUBLIC_KEY=<the public key already in Dokploy for Teams push — do NOT regenerate>
VAPID_PRIVATE_KEY=<the private key already in Dokploy for Teams push>
VAPID_SUBJECT=<the subject already in Dokploy, e.g. mailto:admin@example.com>
```

**VAPID keys**: copy the exact values already set in Dokploy for the existing Teams web push
(`VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT`). Regenerating them will silently
invalidate every installed PWA's push subscription — devices won't receive notifications until
they re-subscribe.

If VAPID keys were never configured, generate them once:
```sh
node -e "const {generateVAPIDKeys:g}=require('web-push'); console.log(JSON.stringify(g(),null,2))"
```

### 2. No new volume or service needed

The existing `cdp-web-data` volume mounts at `/data`. `chat.db` lives there automatically via
`CHAT_DB_PATH=/data/chat.db` (baked into the Dockerfile). No Dokploy config change required for
the volume.

### 3. Redeploy

Trigger a **Redeploy** on the Dokploy Application. The new image builds with both processes and
boots via `docker-entrypoint.sh`.

### 4. Verify

Check the container logs — you should see two startup lines:

```
chat-server listening on :7810
Web server listening on :7800   (or similar)
```

Then hit the public origin:

```sh
# BFF health (through the server.mjs proxy)
curl https://portal.dp.dustin.one/api/chat/health
# → {"ok":true,"service":"chat-server"}

# Chat UI
curl -I https://portal.dp.dustin.one/chat
# → HTTP/2 200

# Conversations (requires Teams keeper tab to be live)
curl https://portal.dp.dustin.one/api/chat/conversations?service=teams
```

If the BFF fails to start, the container will exit and Dokploy will restart it (the watchdog in
`docker-entrypoint.sh` kills `server.mjs` when `chat-server` dies, so both restart cleanly).

---

## Preview deployments

Each preview branch gets its own container. `chat.db` starts **empty** on a fresh preview volume.
To populate it: open `/chat` → Settings → Data → pick a backfill window → Run. The sweep will
keep it live after that.

---

## Rollback

If something goes wrong, roll back to the previous image tag in Dokploy. The `/data` volume is
unchanged (adding `chat.db` is additive; the old image ignores it).
