# Persistent data volume (prod)

All server state the web build writes — the Teams chat SQLite store, settings, pins + browsing
history, notifications, push subscriptions, and the Slack registry/sweep state — lives in **one
directory**, `DATA_DIR` (default `/data` in the container image). Mount a persistent volume there on
prod so a redeploy doesn't wipe folders, labels, read-state, or pins.

## Why this matters

`web-teams.db` and the JSON state files are on the container filesystem. A redeploy replaces that
filesystem, so without a mounted volume every deploy starts from an empty DB — which is why chat
folders/labels vanished on each new deploy (t163). The chat *messages* re-sync from Teams, but the
**local-only** prefs (folders, labels, per-conversation mutes, read-state, pins) exist nowhere else.

## What's stored under `DATA_DIR`

| File | Contents |
|---|---|
| `web-teams.db` | Teams chat store — conversations, messages, **conversation_prefs (folders/labels/mutes)**, read-state |
| `settings.json` | Host/port/theme/pins + per-device ui-state (chat settings, folder collapse) |
| `web-history.json` | Browsing history (cross-device sync source) |
| `web-notifications.json` | Captured notification store |
| `web-push-subs.json` / `teams-push-subs.json` | Web Push subscriptions |
| `slack-workspaces.json` / `slack-sweep-state.json` | Slack registry + sweep watermark |
| `teams-notify-state.json` | Teams notify sweep watermark |

## Docker Compose (already wired)

`docker-compose.yml` sets `DATA_DIR: /data` and mounts the named volume `cdp-web-data:/data`. Named
volumes survive `docker compose up --build`, so a plain compose redeploy already persists. Nothing
to do beyond keeping the volume.

## Dokploy / prod

The prod app must mount a persistent volume at `/data`:

1. In the app's **Volumes** (or **Mounts**) config, add a volume mount with **Mount Path** `/data`.
   Use a named/host volume that survives redeploys (not a bind to an ephemeral build dir).
2. `DATA_DIR=/data` is already baked into the image env, so no extra env is needed. (To relocate,
   set `DATA_DIR` to the mount path.)
3. Redeploy. Verify: create a folder/label in `/chat`, redeploy, confirm it's still there.

**Previews stay ephemeral by design** (PSN-90 Phase 2 decision): per-branch preview apps get no
persistent volume, so their chat state resets on each deploy. Only prod (the daily driver) mounts
the volume. If a preview needs to keep state for testing, add the same `/data` mount to that
preview app.

## Local dev / Electron

`DATA_DIR` is unset locally, so the files default to the repo root (the pre-t163 behaviour) —
`pnpm web` writes `web-teams.db` etc. next to `web/server.mjs`. Electron doesn't use this server.
