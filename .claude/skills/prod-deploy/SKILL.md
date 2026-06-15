---
name: prod-deploy
description: Deploy cdp-browser's web build to production — the `cdp-browser` Dokploy compose on the `dokploy-dell01` node. Use when the user says "deploy", "/prod-deploy", "ship to prod", "redeploy", "push it live".
---

# prod-deploy

Production is the **`cdp-browser`** Docker-compose service on **Dokploy** (control plane
`dokploy.dustin.one`), deployed to the remote server **`dokploy-dell01`** — a privileged Debian LXC
on the home Proxmox box (`dell01`). Dokploy builds the repo's `Dockerfile` and runs `web/server.mjs`
(port 7800) in the `cdp-browser-web` container, proxying CDP to the browser on **`glkvm`**
(`100.85.206.8:9222`). Reached at **`https://dokploy-dell01.hinny-dory.ts.net:8443/`** over Tailscale.

> Migrated off the old `m4-pro-mbp` launchd setup on 2026-06-15. If `com.dustin.cdp-browser` is still
> running on m4, that's the deprecated parallel copy — ignore it for deploys.

**Prod is outward-facing and hard to reverse.** A bad bundle 502s the daily driver (an ESM import
error has burned a deploy cycle before). Verify locally before you push.

## Facts

- **Auto-deploy:** pushing to **`main`** redeploys automatically (Dokploy GitHub App, `autoDeploy` on
  the compose). This is the normal path — merge to main and push.
- **Manual deploy** (Dokploy API; key in Proton Pass — never inline it):
  ```bash
  KEY=$(pass-cli item view "pass://Personal/dokploy/api_key")
  curl -s -X POST https://dokploy.dustin.one/api/compose.deploy \
    -H "x-api-key: $KEY" -H "Content-Type: application/json" \
    -d '{"composeId":"Fru7-xNVXKjQUb3PHWPIi"}'
  ```
  …or the Dokploy UI → project **CDP Browser** → service **cdp-browser** → Deploy.
- **Runtime host:** `ssh root@dokploy-dell01`. Container `cdp-browser-web` (bridge net) listens `:7800`,
  exposed at `:8443` via `tailscale serve`. Compose env: `CDP_HOST=100.85.206.8`, `CDP_PORT=9222`,
  `HOST_PORT=7800`, `APP_TITLE="CDP Portal"`. The container reaches glkvm over Tailscale via bridge NAT (no
  `network_mode: host`).
- **Build runs on the node** (Dokploy clones the repo + `docker compose up -d --build`) — no pnpm/node
  needed on your laptop for the deploy itself.

## Workflow

### 1. Verify locally FIRST (never skip — prod has no test gate)

```bash
pnpm typecheck && pnpm test && node --check web/server.mjs
```
`node --check` catches the ESM import errors that 502 prod. Optionally `pnpm test:e2e` for
transport/notification changes.

### 2. Ship via main (normal path)

```bash
git push origin <branch>        # then merge to main (PR or fast-forward) and push main
# pushing main auto-deploys — watch it in the Dokploy UI or poll the API (below).
```
To verify a feature branch in prod before merge: set the compose branch in Dokploy and trigger a
manual deploy. Default prod branch is **main**.

### 3. Health-check the live service (the deploy isn't done until this passes)

```bash
# from anything on the tailnet
curl -s https://dokploy-dell01.hinny-dory.ts.net:8443/api/config   # {"host":"100.85.206.8","port":9222}

# on the node
ssh root@dokploy-dell01 '
  docker ps --filter name=cdp-browser-web --format "{{.Status}}";   # want: Up ... (healthy)
  docker logs cdp-browser-web --tail 8;                             # boot lines, no errors
  curl -s localhost:7800/api/config'
```
Confirm: container `Up (healthy)`, `/api/config` → `{"host":"100.85.206.8","port":9222}`, and the PWA
loads at the `:8443` URL.

Poll the deploy status:
```bash
KEY=$(pass-cli item view "pass://Personal/dokploy/api_key")
curl -s -H "x-api-key: $KEY" \
  "https://dokploy.dustin.one/api/compose.one?composeId=Fru7-xNVXKjQUb3PHWPIi" | jq -r .composeStatus
# running -> done
```

## Rollback

Revert the bad commit on `main` and push (auto-deploys), or redeploy a prior deployment from the
Dokploy UI. `restart: unless-stopped` keeps the last good image running on crash, but a bad build
needs a re-deploy of a good ref — don't expect auto-heal.

## Notes

- The controlled browser (machine A) → `glkvm` reverse-tunnel chain is **independent** of this deploy.
  If CDP is dead, check glkvm first: `curl http://100.85.206.8:9222/json/version` (from the node).
- `CDP_HOST` must be an **IP or `localhost`** — CDP rejects DNS Host headers, so prod uses glkvm's raw
  tailnet IP, not a MagicDNS name.
- Ignore the obsolete `cdp-browser-web-ziao0f` compose on cloud01 — dead leftover, not prod.
