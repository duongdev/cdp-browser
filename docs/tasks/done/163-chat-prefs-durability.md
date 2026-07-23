# t163 — Prefs durability: one DATA_DIR under a persistent volume

Status: done
Depends on: —
Scope: `web/server.mjs` + `Dockerfile` + `docker-compose.yml` + a deploy guide.
Plan: PSN-90 Phase 2, workstream P (item 11).

## Root cause

Folders/labels vanished on every new preview deploy because the chat state lives in
`web-teams.db` on the container filesystem, which a redeploy replaces. Worse: only *some* state
files were routed to the persistent `/data` volume (teams DB, settings, notifications) — **pins,
browsing history, push subs, and Slack registry/sweep state defaulted to the repo root inside the
container**, so they were ephemeral even on prod.

## What shipped

- **One `DATA_DIR`** (`web/server.mjs`, default = repo root): every stateful file's path default now
  routes under it via a `dataPath()` helper — `web-teams.db`, `web-settings.json`,
  `web-history.json`, `web-notifications.json`, `web-push-subs.json`, `teams-push-subs.json`,
  `teams-notify-state.json`, `slack-workspaces.json`, `slack-sweep-state.json`. The dir is
  `mkdirSync`-created on boot. Every per-file `_PATH` env override still wins (back-compat), and an
  unset `DATA_DIR` keeps the pre-t163 repo-root behaviour (local dev + Electron unchanged).
- **Docker**: `Dockerfile` + `docker-compose.yml` set `DATA_DIR=/data` (kept the legacy
  `SETTINGS_PATH`/`NOTIFS_PATH=/data/settings.json` filenames so the existing volume's files aren't
  orphaned). The compose named volume `cdp-web-data:/data` already persists across rebuilds.
- **Deploy guide** (`docs/guides/persistent-data-volume.md`): what's stored, the Dokploy `/data`
  mount step, and the decision that **previews stay ephemeral** (only prod mounts the volume).

## Verification

- Booted `DATA_DIR=/tmp/… node web/server.mjs` → `web-settings.json` landed in the target dir and
  the dir was auto-created.
- `node --check web/server.mjs` clean; biome clean on the changed lines.
- Prod action required (human): mount a persistent volume at `/data` on the prod Dokploy app, then
  verify a folder/label survives a redeploy.
