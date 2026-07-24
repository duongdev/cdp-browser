# syntax=docker/dockerfile:1
# Web build of CDP Browser: a Node proxy that serves the built renderer over
# SSE + POST and bridges to a remote CDP host over WS. See docs/adr/0006.
# Electron is NOT involved — this image is the web backend only.

# ---- build the renderer (needs devDependencies: vite, etc.) ----------------
FROM node:24-alpine AS builder
WORKDIR /app
# git for the commit SHA; python3/make/g++ so better-sqlite3 compiles its native binary here (alpine
# musl has no prebuilt). The compiled module is copied into the slim runtime stage below.
RUN corepack enable && apk add --no-cache git python3 make g++
# Full install WITH scripts so better-sqlite3's postinstall builds. pnpm-workspace.yaml carries the
# `allowBuilds` allowlist (better-sqlite3: true) — without it pnpm v11 refuses the native build with
# ERR_PNPM_IGNORED_BUILDS and exits 1. The husky `prepare` hook is non-fatal without a git repo.
COPY .npmrc package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
# Bake the commit SHA for /api/version + the About panel's Build field. .git is in the
# build context (no longer .dockerignored); degrade to "unknown" if it's ever absent so
# the build never fails. Only this tiny file ships to runtime, never .git itself.
RUN git rev-parse --short HEAD > .gitsha 2>/dev/null || echo unknown > .gitsha
# Build BOTH renderers: the main CDP-browser SPA (dist/) and the Teams chat app (dist-chat/),
# which web/server.mjs serves at /chat. Skipping chat:build would 404 the whole Teams app on prod.
RUN pnpm build && pnpm chat:build

# ---- runtime: only `ws` + the server + built assets ------------------------
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY .npmrc package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Create the workspace package stub so pnpm installs chat-server's prod deps (hono,
# @hono/node-server, web-push, ws) into node_modules alongside the root deps.
RUN mkdir -p apps/chat-server
COPY apps/chat-server/package.json ./apps/chat-server/package.json
RUN pnpm install --prod --frozen-lockfile --ignore-scripts && pnpm store prune
# --prod --ignore-scripts leaves better-sqlite3 without its compiled native binary (web/server.mjs
# imports it for the Teams chat SQLite store; missing → "Could not locate the bindings file" at boot).
# Copy the module the builder already compiled (same node:24-alpine base → abi-compatible), instead of
# shipping a toolchain into the runtime image.
COPY --from=builder /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3

# Copy the TS source so `node --experimental-transform-types` can run it at runtime (no compile step).
COPY --from=builder /app/apps/chat-server ./apps/chat-server

# Built renderers + the server + the shared core/ CJS modules and inject scripts it reads.
# core/*.js covers every module web/server.mjs imports via `../core/*.js` — a missing one
# fails at boot with ERR_MODULE_NOT_FOUND. (*.test.ts files are not matched.) dist-chat is the
# Teams chat app served at /chat.
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/dist-chat ./dist-chat
COPY --from=builder /app/.gitsha ./.gitsha
COPY web ./web
COPY core/*.js ./core/
COPY inject ./inject

# Entrypoint: starts chat-server (background, :7810) then web/server.mjs (foreground, :7800).
# If either process dies the container exits so Docker's restart policy recovers both.
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x docker-entrypoint.sh

# ALL stateful files (chat SQLite store, settings, pins/history, notifications, push subs, Slack
# registry/sweep state) live under the persistent /data volume so a redeploy never wipes
# folders/labels/read-state/pins (t163). One DATA_DIR var routes every default there — the two
# legacy SETTINGS_PATH/NOTIFS_PATH keep the /data/settings.json filenames the existing volume
# already holds (DATA_DIR alone would rename them to web-settings.json and orphan the old data).
# BFF listens on loopback :7810 (internal only); server.mjs proxies /api/chat/* to it.
# VAPID keys and CHAT_INTERNAL_SECRET come from the compose/Dokploy env at runtime (not baked here).
ENV PORT=7800 \
    DATA_DIR=/data \
    SETTINGS_PATH=/data/settings.json \
    NOTIFS_PATH=/data/notifications.json \
    CHAT_SERVER_PORT=7810 \
    CHAT_SERVER_URL=http://localhost:7810 \
    TEAMS_UPSTREAM_URL=http://localhost:7800 \
    CHAT_DB_PATH=/data/chat.db

# Persisted settings/notifications live in /data; run unprivileged.
RUN mkdir -p /data && addgroup -S app && adduser -S app -G app && chown -R app /data /app
USER app
EXPOSE 7800

# Healthy = the web server answers, even if the CDP host is unreachable.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7800)+'/api/config').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
