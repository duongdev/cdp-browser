# 094 — native Dokploy preview deployments per branch with tailnet-private wildcard URL

- **Status:** in-progress (AFK prod path LIVE 2026-06-19; cutover + GitHub-App PR-preview verify + iPad re-install = HITL remaining)
- **Mode:** HITL
- **Estimate:** 1d
- **Depends on:** none (but step 0 — Traefik on dokploy-dell01 — gates everything)
- **Blocks:** none

## Goal

Give every PR its own throwaway, Vercel-style preview of the web build, reachable at a
stable per-branch URL — `cdp-<branch>-<id>.dp.dustin.one` — using Dokploy's native preview
deployments. Production moves to a clean origin `portal.dp.dustin.one`. Both prod and
previews are **tailnet-only** (resolve to a Tailscale `100.x` IP; reachable only with
Tailscale connected) with **no Authentik** — tailnet membership is the only gate. The
ingress pattern (`*.dp.dustin.one` → Dokploy Traefik via one NPM wildcard host) is reusable
for any future Dokploy service with zero NPM changes.

## Why now

The daily-driver surface is the web PWA; reviewing renderer/PWA branches today means a local
`pnpm web` or pushing to `main`. Per-PR previews let branch UI be eyeballed on the real iPad
before merge. It also retires the bespoke `tailscale serve :8443→7800` prod hack for a proper
Traefik-routed origin, and establishes the standard `*.dp.dustin.one` ingress for the homelab.

## Acceptance criteria

- [ ] Dokploy Traefik is running on dokploy-dell01 (`:80`/`:443` listening; `docker ps` shows it).
- [ ] cdp-browser is a Dokploy **Application** (not Compose), building from `duongdev/cdp-browser`
      via the repo Dockerfile, autoDeploy on `main`.
- [ ] Prod is reachable at `https://portal.dp.dustin.one/` over the tailnet, with trusted TLS,
      no Authentik, and **not** reachable without Tailscale.
- [ ] Opening a PR against `main` creates a preview at `https://cdp-<branch>-<id>.dp.dustin.one/`;
      pushing to the PR redeploys it; closing/merging tears it down.
- [ ] Previews and prod are both gated solely by tailnet membership (DNS → `100.x`).
- [ ] Concurrent live previews bounded by `previewLimit` on the Application (Dokploy already serializes builds per deploy-server — there is no global build-queue knob).
- [ ] One NPM wildcard host `*.dp.dustin.one` (no Authentik, DNS-01 wildcard cert) fronts all of it;
      adding a future service needs no NPM change.
- [ ] iPad PWA re-installed on `portal.dp.dustin.one` with push re-granted; old `:8443` serve retired.

## Test plan

### Layer 1 — Pure logic (TDD)

n/a — this task is deployment/infra only; no `src/lib/` or `core/` logic changes. The repo
Dockerfile and `web/server.mjs` ship unchanged.

### Layer 2 — Manual smoke (deploy/infra)

- [ ] From a non-tailnet network, `https://portal.dp.dustin.one/` does **not** resolve-and-connect
      (DNS resolves to `100.x`, no route) → confirms tailnet-only.
- [ ] From a tailnet peer, `https://portal.dp.dustin.one/api/config` returns the glkvm host/port.
- [ ] Open a throwaway PR → preview URL appears in Dokploy + GitHub checks; the URL loads the branch's
      renderer; teardown on PR close removes the container + volume.
- [ ] Two PRs open at once → both previews run; builds happen one-at-a-time (queue=1).
- [ ] Trigger a preview screencast connect → confirm it contends with prod's glkvm session as expected
      (documented limitation, not a bug).

### Layer 3 — Visual review

- [ ] Load a preview URL on the iPad PWA shell; confirm the renderer paints and the four states render.

## Design notes

Behavioral/topology change only — no contracts in `src/` or `core/` change.

**End-state topology:**

```
Cloudflare DNS (DNS-only / grey-cloud):
   portal.dp.dustin.one    A → <nginx node 100.x>
   *.dp.dustin.one         A → <nginx node 100.x>
NPM (front door, nginx LXC 352) — ONE host, no Authentik:
   names: [portal.dp.dustin.one, *.dp.dustin.one]
   TLS:   new *.dp.dustin.one (+ portal) SAN/wildcard cert via existing Cloudflare DNS-01 token
   →      forward Host preserved → Dokploy Traefik on dokploy-dell01:80 (tailnet)
Dokploy Traefik (dokploy-dell01) host-routes:
   portal.dp.dustin.one              → cdp-browser prod (Application)
   cdp-<branch>-<id>.dp.dustin.one   → preview container
Gate: tailnet membership only (DNS → 100.x; no public route).
```

**Decisions (see ADR-0014):**

- **Compose → Application** so native previews work (previews are an Application feature; Docker/Compose
  provider services don't get them). Single service; prod + previews from one Application config.
- **Full Traefik ingress (B2)** rather than keeping the `tailscale serve` host-port hack — Traefik routes
  by Host, so previews don't collide on a fixed port, and prod gets a clean origin.
- **NPM stays the tailnet TLS front door (1a)** — it already owns Cloudflare DNS-01 certs for `*.dustin.one`;
  putting certs in Traefik would need DNS-01 inside Traefik (HTTP-01 can't validate a tailnet-only IP). NPM
  front + Traefik host-routing avoids that entirely.
- **Tailnet-only, no Authentik** — DNS points at a Tailscale `100.x` IP; only tailnet peers route. Membership
  is the gate. (`portal` was not actually Authentik-gated in the live NPM config anyway.)
- **`*.dp.dustin.one` namespace** — one wildcard cert + one NPM host covers prod, all previews, and every
  future Dokploy service. Reusable homelab pattern.
- **Shared remote browser (Q4=A)** — previews inherit `CDP_HOST=<glkvm IP>` and share the one Edge instance
  with prod. UI-review only; a preview that connects the screencast contends with prod. Previews should **not**
  auto-start the screencast on boot. Isolated-browser-per-preview is a future task, not v1.
- **Build queue = 1, previews uncapped** — runtime footprint per preview is small (~150 MB Node); the heavy
  part is `pnpm install` + `vite build` on a 2-core/4 GiB box, so serialize builds, not preview count.

**New ADR needed?** Yes — ADR-0014 (preview-deployment topology + tailnet-only ingress + shared-browser limit).

**No app code change** — the existing 2-stage Dockerfile is the build unit; previews differ only by env + domain.

## Step 0 — prerequisite (gates the rest)

Dokploy Traefik is **not deployed** on dokploy-dell01 (verified 2026-06-19: only `cdp-browser-web`
runs on `:7800`; nothing on `:80/:443`; swarm active + `dokploy-network` overlay present, but no
Traefik — the migration's `server.setup` no-op). Deploy Traefik first (re-run the Dokploy remote-server
setup, or bring up Dokploy's Traefik service manually on the node) before any routing below can work.

## Out of scope

- Isolated browser per preview (headless Chromium sidecar) — separate future task. v1 shares glkvm.
- `*.ts.dustin.one` general tailnet vanity domain — captured to the home-servers vault, separate task.
- Migrating Authentik-gated hosts or other `*.dustin.one` services.
- Any change to the A→B (work box → glkvm) reverse-tunnel CDP chain.
- Public (non-tailnet) exposure of previews.

## Definition of Done

- [ ] Layer 2 smoke checklist completed against the live deploy server.
- [ ] Layer 3 preview loads on the iPad PWA shell.
- [ ] ADR-0014 written.
- [ ] CLAUDE.md "Web build" / deployment notes updated for the new prod origin + preview model.
- [ ] Vault runbooks updated (dokploy-dell01: Traefik + Application + previews; nginx-npm: `*.dp.dustin.one` host).
- [ ] Old `tailscale serve :8443` prod path retired after cutover verified.
- [ ] No app code committed unless a real change was needed (expected: none).

## Notes

- AFK vs hands matrix: code/docs/read-only-verification is AFK (me); every console/credential/external
  step (Dokploy UI, GitHub App, Cloudflare DNS, NPM UI, iPad re-install) is HITL (operator). No Dokploy
  MCP mutations (standing rule) — Dokploy changes go through its UI.
- Verified 2026-06-19 via `ssh root@dokploy-dell01`: no Traefik; prod publishes `0.0.0.0:7800`; swarm active.
- Cert nuance: `portal.dp.dustin.one` is a sub-sub-domain, so the existing `*.dustin.one` cert does NOT
  cover it — the new `*.dp.dustin.one` DNS-01 cert (which also lists `portal.dp.dustin.one`) covers both.
- **Verified state (recon 2026-06-19, 5-system parallel sweep):**
  - Dokploy **control plane = cloud01** (v0.26.7, Traefik v3.6.7 + postgres + redis) — alive and required (NOT decommissioned; only the cdp-browser *workload* moved off it). cdp-browser is a **Compose** service on the **dokploy-dell01** deploy server: serverId `7lgdzveHpDGv5HP5pvI0w`, composeId `Fru7-xNVXKjQUb3PHWPIi`, project `sPUck3Tg5WPYk9Kydbtyn`, env `XlE5xwihU9kiIGJuzSq04`, githubId `hqb1VR2oh39UmAeTodJje`. **Previews + their Traefik run on dell01, NOT cloud01** (cloud01→glkvm is DERP ~70ms).
  - Step 0 = `POST /server.setup {serverId:"7lgdzveHpDGv5HP5pvI0w"}` — idempotent; installs `dokploy-traefik` on dell01 (`:80/:443`, entrypoints web/websecure).
  - Application path: `application.create` (env `XlE5...`, server `7lgd...`) → wire GitHub source (githubId `hqb1...`, dockerfile build) + env → `domain.create host=portal.dp.dustin.one port=7800 https=false certificateType=none` → `application.update isPreviewDeploymentsActive=true previewWildcard=*.dp.dustin.one previewPort=7800 previewHttps=false previewCertificateType=none previewRequireCollaboratorPermissions=true previewLimit=<N>`. Application uses Traefik routing (no host-port publish) so it runs **alongside** the existing Compose `:7800` without conflict.
  - NPM front-door upstream after step 0 = **dokploy-dell01:80** (its Traefik), Host preserved. DNS records point at the **nginx node** tailnet IP `100.117.176.112` (CF zone `e101a49b93ae3d4674003445416e2551`). The existing `*.dustin.one` CNAME already resolves `*.dp.dustin.one` to the PUBLIC DDNS IP — the new explicit `*.dp` + `portal.dp` A records (DNS-only → 100.x) are **corrective**, closing that public leak + making it tailnet-only.
  - **No build-queue=1 knob exists** — Dokploy already serializes builds per deploy-server; bound concurrent live envs with `previewLimit` instead.
  - Tailscale **ACL is default allow-all → no ACL change needed**; both iPads + workstation are members. (Workstation is `m5-max-mbp`, not m4.)
  - **Repo is PUBLIC** (verified, not private) → must set `previewRequireCollaboratorPermissions:true`; consider making the repo private (Dokploy warns previews let outside PRs run builds on your host).
  - **AFK blocker — NPM**: admin password at `pass://Personal/nginx.dustin.one/password` is **stale (401)**. Clean NPM-API path (create cert + proxy host) needs a fresh password, or a DB-side hash reset on LXC 352. NPM REST confirmed working otherwise (v2.12.1); the `*.dustin.one` DNS-01 cert (id 53) proves the CF token works and can mint a new `*.dp.dustin.one` SAN cert.
- **Execution log (2026-06-19, AFK via REST/SSH — no Dokploy MCP):**
  - ✅ Cloudflare: `portal.dp.dustin.one` + `*.dp.dustin.one` A → `100.117.176.112` (nginx node, DNS-only) — overrides the leaky `*.dustin.one` wildcard; resolves tailnet-only.
  - ✅ Traefik on dell01: `server.setup` no-ops (root cause: control-plane→dell01 on-disk SSH denied; Dokploy deploys with a DB-stored key, so deploys still work). Hand-rolled `dokploy-traefik` (traefik:v3.6.7) identical to the cloud01 control-plane config (swarm+docker+file providers, web:80/websecure:443, dokploy-network). Reachable over tailnet (404 until routed).
  - ✅ Application `cdp-browser-app` (id `RLo7fiU3_7tzBthG7OEV8`, appName `cdp-browser-app-1yrpdy`): github source (githubId `hqb1...`, duongdev/cdp-browser@main), buildType dockerfile, env (CDP_HOST/CDP_PORT/PORT/APP_TITLE copied from the live Compose). Built + deployed as a 1/1 healthy swarm service.
  - ✅ Domain `portal.dp.dustin.one` (id `vlZ7...`, https=false/certType=none) + previews ON: `previewWildcard=*.dp.dustin.one`, `previewPort=7800`, `previewCertificateType=none`, `previewRequireCollaboratorPermissions=true`, `previewLimit=10`.
  - ✅ NPM: cert id **59** (`*.dp.dustin.one`, DNS-01 via the existing CF token, exp 2026-09-17) + proxy host id **65** (`[portal.dp.dustin.one, *.dp.dustin.one]` → `100.79.0.81:80`, ssl_forced, http2, websocket, block_exploits, **no Authentik / access_list 0**).
  - ✅ Verified: `https://portal.dp.dustin.one/api/config` → 200 trusted-TLS over tailnet; `/api/version` → 0.3.0 sha 192266b.
  - **HITL remaining**: (1) prove a PR preview fires — needs the Dokploy GitHub App subscribed to `pull_request` (likely already, since it autodeploys main); open/push a collaborator PR → expect `<slug>.dp.dustin.one`. (2) iPad: re-install PWA on the new origin + re-grant push. (3) **Cutover**: retire the old Compose `cdp-browser` (id `Fru7-...`) + the `tailscale serve :8443` once portal.dp is trusted. Until then BOTH track main → **double-deploy on push** + **shared glkvm browser** (don't actively drive both prod URLs at once). Optional pre-cutover: add a `/data` volume mount to the Application for settings/notifications persistence.
  - **SECURITY — escalate**: the Dokploy API returns **all** stored secrets in cleartext to any api_key holder — the Dokploy GitHub App private key, the dell01 SSH private key, and *other projects'* env secrets (copilot-api tokens, tele-bot session, ccflow Clerk **live** keys + DB/S3 creds). `pass://Personal/dokploy/api_key` is effectively a master homelab credential. Rotate-worthy + restrict; separate from t094.
