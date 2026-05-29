---
name: prod-deploy
description: Deploy cdp-browser's web build to the m4-pro-mbp production server (the prod target). Use when the user says "deploy", "/prod-deploy", "ship to prod", "redeploy", "push it live", or "redeploy m4-pro-mbp".
---

# prod-deploy

Deploys the web build to **m4-pro-mbp** — the production server (launchd-managed `web/server.mjs` on port 7800, proxying CDP host `100.85.206.8:9222`). See the `m4-pro-mbp-deploy` memory for the full host layout.

**Prod is outward-facing and hard to reverse.** Confirm the target/branch with the user before deploying unless they just told you to. A bad bundle 502s the daily driver (an ESM import error has burned a deploy cycle before).

## Facts

- ssh: `ssh m4-pro-mbp` (key auth, non-interactive; real host `openclaw-2.local`).
- Repo on host: `~/cdp-browser`. Ops scripts (not in git): `~/.cdp-browser-deploy/`.
- `redeploy.sh [branch]`: `git fetch` → `checkout <branch>` → `pull --ff-only` → `pnpm install --frozen-lockfile` → `pnpm build` → `launchctl kickstart -k gui/$UID/com.dustin.cdp-browser`. **Defaults to `main`.**
- Deploying a feature branch (verify before merging to main): pass it as the arg. Shipping main: merge the branch to main + push first, then redeploy with no arg.

## Workflow

### 1. Verify locally FIRST (never skip — prod has no test gate)

```bash
pnpm typecheck && pnpm test && node --check web/server.mjs
```

All must pass. `node --check` catches the ESM import errors that 502 prod. Optionally `pnpm test:e2e` for transport/notification changes.

### 2. Push the code to GitHub (redeploy pulls from origin)

```bash
git push -u origin <branch>     # the branch you'll deploy
# shipping main instead? merge the branch to main and push main first.
```

### 3. Deploy

```bash
ssh m4-pro-mbp '~/.cdp-browser-deploy/redeploy.sh <branch>'   # omit <branch> to deploy main
```

Wait for `redeployed to <branch> and restarted`.

### 4. Health-check the live service (the deploy isn't done until this passes)

```bash
ssh m4-pro-mbp 'launchctl print gui/$UID/com.dustin.cdp-browser | grep -iE "state|pid"; \
  echo "--- err log (want empty) ---"; tail -5 ~/.cdp-browser-deploy/logs/cdp-browser.err.log; \
  echo "--- booted? ---"; tail -3 ~/.cdp-browser-deploy/logs/cdp-browser.log; \
  echo "--- deployed commit ---"; cd ~/cdp-browser && git log --oneline -1; \
  echo "--- serves? ---"; curl -s --max-time 6 localhost:7800/api/config'
```

Confirm: `state = running`, **err log empty**, the boot line `[web] http://0.0.0.0:7800 -> cdp 100.85.206.8:9222`, the deployed commit matches the intended HEAD, and `/api/config` returns `{"host":"100.85.206.8","port":9222}`.

External sanity (optional): `curl -s http://m4-pro-mbp.taila82239.ts.net:7800/api/config`.

## Rollback

Redeploy a known-good ref: `ssh m4-pro-mbp '~/.cdp-browser-deploy/redeploy.sh main'` (or a prior commit/branch). The plist `KeepAlive` auto-restarts on crash, but it will not fix a bad build — roll back the ref.

## Notes

- After the user verifies a feature-branch deploy in prod, the follow-up is usually: merge to main, push, redeploy with no arg (so prod tracks main again).
- Never edit anything under `~/.cdp-browser-deploy/` (intentionally outside git) or move `~/cdp-browser` (paths baked into the plist).
