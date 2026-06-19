# syntax=docker/dockerfile:1
# Web build of CDP Browser: a Node proxy that serves the built renderer over
# SSE + POST and bridges to a remote CDP host over WS. See docs/adr/0006.
# Electron is NOT involved — this image is the web backend only.

# ---- build the renderer (needs devDependencies: vite, etc.) ----------------
FROM node:24-alpine AS builder
WORKDIR /app
RUN corepack enable && apk add --no-cache git
# Install with the lockfile first for layer caching. --ignore-scripts skips the
# husky `prepare` hook (it would try to wire git hooks during the build).
COPY .npmrc package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY . .
# Bake the commit SHA for /api/version + the About panel's Build field. .git is in the
# build context (no longer .dockerignored); degrade to "unknown" if it's ever absent so
# the build never fails. Only this tiny file ships to runtime, never .git itself.
RUN git rev-parse --short HEAD > .gitsha 2>/dev/null || echo unknown > .gitsha
RUN pnpm build

# ---- runtime: only `ws` + the server + built assets ------------------------
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY .npmrc package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts && pnpm store prune

# Built renderer + the server + the shared core/ CJS modules and inject scripts it reads.
# core/*.js covers every module web/server.mjs imports via `../core/*.js` — a missing one
# fails at boot with ERR_MODULE_NOT_FOUND. (*.test.ts files are not matched.)
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/.gitsha ./.gitsha
COPY web ./web
COPY core/*.js ./core/
COPY inject ./inject

ENV PORT=7800 \
    SETTINGS_PATH=/data/settings.json \
    NOTIFS_PATH=/data/notifications.json

# Persisted settings/notifications live in /data; run unprivileged.
RUN mkdir -p /data && addgroup -S app && adduser -S app -G app && chown -R app /data /app
USER app
EXPOSE 7800

# Healthy = the web server answers, even if the CDP host is unreachable.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7800)+'/api/config').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "web/server.mjs"]
