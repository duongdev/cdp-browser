# 010 — dockerize web build with compose

- **Status:** done
- **Mode:** AFK
- **Estimate:** 0.5d
- **Depends on:** 007, 008, 009
- **Blocks:** none

## Goal

Ship the web build as a container. A multi-stage `Dockerfile` builds the renderer
with pnpm then runs `web/server.mjs` on a slim Node runtime carrying only the
server, the built `dist/`, the pure CJS modules + inject scripts it reads, and
the single runtime dep (`ws`). A `docker-compose.yml` wires the CDP host, port,
persisted settings volume, and page title via env. After this task the web app
deploys with `docker compose up` behind the operator's own nginx + an SSO proxy.

## Why now

t007–t009 made the web build run from source (`pnpm web`). Deploying it by hand
(install Node, build, run, keep alive) is fragile. A container is the shippable
unit and the natural seam for the operator's reverse proxy.

## Acceptance criteria

- [x] `docker build` produces an image that serves `dist/` + the `/api/*` surface.
- [x] Container runs unprivileged, persists settings/notifications to a `/data` volume.
- [x] `CDP_HOST`/`CDP_PORT`/`PORT`/`APP_TITLE`/`SETTINGS_PATH`/`NOTIFS_PATH` are env-driven.
- [x] `HEALTHCHECK` reports healthy when the server answers (independent of CDP).
- [x] `docker-compose.yml` exposes the port, mounts the volume, passes env;
      `.env.example` documents the knobs; `.dockerignore` trims the build context.
- [x] Favicon uses the app icon; page title defaults to "CDP Portal", env-overridable.

## Test plan

### Layer 1 — Pure logic (TDD)

n/a — packaging + a static-serve tweak; no pure logic.

### Layer 2 — Manual smoke

- [x] `docker build` succeeds.
- [x] `docker run` → `GET /` 200, `/api/config` returns config, `HEALTHCHECK` healthy.
- [x] Served `index.html` carries the env title; `APP_TITLE` override changes it;
      `/icon.svg` serves the app icon.
- [x] Settings persist across container restarts via the volume.

### Layer 3 — Visual review

n/a — no new UI (favicon/title verified by served-HTML inspection).

## Design notes

- **Contracts changed:** none. `serveStatic` rewrites `index.html`'s `<title>` to
  `APP_TITLE` in flight (web only; Electron loads the file directly and keeps its
  baked title).
- **New files:** `Dockerfile`, `.dockerignore`, `docker-compose.yml`,
  `.env.example`, `public/icon.svg` (favicon, copied from the Electron icon).
- **New ADR needed?** no — covered by ADR-0006.

### Deployment caveats (recorded for the operator)

- **`CDP_HOST` must be an IP or `localhost`.** CDP rejects DNS Host headers
  ("Host header is specified and is not an IP address or localhost"), so a
  hostname (incl. `host.docker.internal`) fails the `/json` call.
- **Reaching the CDP host from the container:** on a Linux host, bridge
  networking NATs to the LAN, so a LAN/Tailscale IP works as-is. Docker Desktop
  for **Mac** does not route containers to arbitrary LAN hosts — test there with
  `pnpm web` (no container) or deploy on Linux. `network_mode: host` (Linux) is
  the fallback for Tailscale-only routing.
- Auth/TLS/nginx are operator-owned, in front of the container.

## Out of scope

- nginx + SSO-proxy config, TLS certs — operator-owned.
- Multi-arch image publishing / registry push.
- Refactoring `main.js` onto the shared core — captured follow-up.

## Definition of Done

- [x] `docker build` + `docker run` verified (serve, health, title, favicon, env override).
- [x] `pnpm test` / `pnpm typecheck` / `pnpm check` green.
- [x] No AI attribution; t010 in branch + commit.
- [x] Task closed: status → done, moved to `done/`.

## Notes

Runtime image carries only `ws` (the server's lone external import); the renderer
libs in `dependencies` are bundled into `dist/` by Vite at build time and not
loaded at runtime. Verified container-served title default ("CDP Portal") and
override ("My Portal"), and `/icon.svg`.
