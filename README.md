# CDP Browser

A lightweight Electron app that connects to a remote Chromium-based browser via [Chrome DevTools Protocol (CDP)](https://chromedevtools.github.io/devtools-protocol/), providing a native-like browsing experience with real-time screencast, tab management, and full input forwarding.

![CDP Browser Screenshot](build/screenshot.png)

## Features

- **Real-time screencast** — JPEG frame stream from the remote browser rendered on a canvas
- **Full input forwarding** — mouse clicks, movement, scroll, keyboard events; macOS-reserved combos fall through to native handlers
- **Tab management** — create, close, switch, drag-reorder, and reopen closed tabs
- **Pins** — hold live tabs; click shows the tab's content, cmd/middle-click opens an independent tab; drag-reorder; edit title/URL
- **Notifications** — Teams and Outlook (OWA) toast capture via read-only CDP side-channels; bell badge + OS alerts; deep-open exact message from notification
- **Arc-like UI** — collapsible sidebar, pill-shaped URL bar, shadcn/ui components
- **Light / Dark / System theme** — with smooth transitions
- **Adaptive Viewport** — optional mode that eliminates letterbox bars by resizing the remote page to match the canvas
- **Navigation history** — back/forward buttons reflect actual browser history
- **Keyboard shortcuts** — see table below
- **Configurable** — remote CDP host/port via settings drawer, with immediate reconnect on save
- **macOS native** — hidden title bar with traffic light integration

## Prerequisites

A Chromium-based browser running with remote debugging enabled:

```bash
# Chrome
google-chrome --remote-debugging-port=9222

# Microsoft Edge
msedge --remote-debugging-port=9222

# Chromium
chromium --remote-debugging-port=9222
```

The browser can be on the same machine or accessible over the network (e.g., via SSH tunnel or Tailscale). See [Reaching a remote CDP browser through a Tailscale jump host](docs/guides/remote-cdp-over-tailscale.md).

## Installation

```bash
git clone https://github.com/duongdev/cdp-browser.git
cd cdp-browser
pnpm install
```

Requires Node 24 (`node-linker=hoisted` is set in `.npmrc`).

## Usage

### Development

```bash
pnpm dev
```

Starts Vite dev server + Electron with hot reload.

### Production

```bash
pnpm start
```

Builds the renderer and launches Electron.

### Package for distribution

```bash
pnpm dist        # Creates DMG + ZIP
pnpm dist:dir    # Creates unpacked app (faster, for testing)
```

Output goes to `release/`.

### Install to /Applications

```bash
pnpm install:local   # Build + install CDP Browser.app (strips quarantine)
```

## Configuration

On first launch, configure the remote CDP address via `⌘,` (Settings):

- **Host**: IP or hostname of the machine running the remote browser (default: `localhost`)
- **Port**: CDP debugging port (default: `9222`)

Settings are persisted in the Electron userData directory.

## Deployment (web build → production)

Production is the **web build**, run via **Dokploy** as the `cdp-browser` compose on the
**`dokploy-dell01`** server — a Debian LXC on the home Proxmox box, registered as a remote
deploy server of the Dokploy control plane at `dokploy.dustin.one`. Dokploy builds this repo's
`Dockerfile` and runs `web/server.mjs` (port 7800) in the `cdp-browser-web` container, proxying
CDP to the browser on `glkvm` (`100.85.206.8:9222`).

- **Deploy = push to `main`.** Dokploy auto-deploys on push (GitHub App, `autoDeploy` on the
  compose). Verify locally first — prod has no test gate:
  ```bash
  pnpm typecheck && pnpm test && node --check web/server.mjs
  ```
- **Live URL:** `https://dokploy-dell01.hinny-dory.ts.net:8443/` (Tailscale serve → container `:7800`).
- **Manual deploy / rollback:** Dokploy UI → project **CDP Browser** → service **cdp-browser**
  (Deploy / redeploy a prior deployment), or revert the bad commit on `main` and push.
- **Env (set on the compose):** `CDP_HOST=100.85.206.8`, `CDP_PORT=9222`, `HOST_PORT=7800`,
  `APP_TITLE`. `CDP_HOST` must be an IP or `localhost` — CDP rejects DNS Host headers.
- **Health check:** `curl https://dokploy-dell01.hinny-dory.ts.net:8443/api/config` →
  `{"host":"100.85.206.8","port":9222}`; on the node, `docker ps` shows `cdp-browser-web` healthy.

The controlled browser (machine A) → `glkvm` reverse-tunnel chain is independent of this deploy —
see `docs/guides/remote-cdp-over-tailscale.md`.

### Production logs

The server logs to stdout, captured by Docker. Read them over Tailscale SSH (no Dokploy UI needed):

```bash
ssh root@dokploy-dell01 "docker logs --tail 100 cdp-browser-web"           # recent
ssh root@dokploy-dell01 "docker logs -f cdp-browser-web"                   # follow live
ssh root@dokploy-dell01 "docker logs cdp-browser-web 2>&1 | grep -aE '\[notif\]|\[push\]|\[dedup\]'"
```

Greppable prefixes (all `console.log`):

- `[web]` — boot line `v{version} {sha} http://… -> cdp …`; the `v…` form confirms which build is live (`sha` is `unknown` in the Docker image — it ships no `.git`).
- `[slack-creds]` / `[slack-sweep]` — Slack cred extraction + sweep activity (`seeded`, `+N entries`, `unsweepable (rate_limited)`).
- `[notif]` — every ingested notification: `id adapter groupKey team`. Proves Enterprise Grid entries key by the merged `slack:{groupId}` while keeping a concrete `team`.
- `[dedup]` — a Grid duplicate dropped at ingest (the org pseudo-team + a member workspace produced the same message). This is the t092 dedup firing.
- `[push]` — per-device Web Push fan-out (t093): one line per subscription (`sent unread=N`, or `skip:muted(<key>)` / `skip:master-off`) + a summary. Only appears once ≥1 device has push enabled.

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `⌘,` | Open Settings |
| `⌘T` | New tab |
| `⌘W` | Close current tab |
| `⌘⇧T` | Reopen last closed tab |
| `⌃Tab` / `⌃⇧Tab` | Next / Previous tab |
| `⌘1`–`⌘9` | Switch to pin/tab by position (pins first, 9 = last) |
| `⌘L` | Focus address bar |
| `⌘⌥L` | Copy current URL |
| `⌘R` | Reload page |
| `⌘[` / `⌘]` | Back / Forward |
| `⌘D` | Pin / unpin current tab |
| `⌘S` | Toggle sidebar |
| `Esc` | Unfocus address bar |

Trackpad swipe left/right is supported for back/forward navigation.

## How It Works

```
[CDP Browser] --HTTP--> [Remote Browser :9222/json]     (tab list, create, close)
[CDP Browser] --WS----> [Remote Browser WS endpoint]   (screencast, input, navigation)
```

1. The app connects to the CDP HTTP API to list and manage tabs.
2. When a tab is selected, it opens a WebSocket to that tab's debugger endpoint.
3. `Page.startScreencast` streams JPEG frames drawn to a canvas.
4. Mouse and keyboard events are mapped and forwarded via `Input.dispatch*` methods.
5. Read-only side-channel sockets attach to notification-capable tabs (Teams, Outlook/OWA) and capture in-app toasts; clicking a notification activates the tab and, for Outlook, deep-opens the exact message via SPA navigation.

## Tech Stack

- [Electron](https://www.electronjs.org/) — desktop runtime
- [React 19](https://react.dev/) — UI framework
- [Tailwind CSS 4](https://tailwindcss.com/) — styling
- [shadcn/ui](https://ui.shadcn.com/) — component library (radix-nova preset)
- [HugeIcons](https://hugeicons.com/) — icon set
- [dnd-kit](https://dndkit.com/) — drag and drop
- [Vite](https://vite.dev/) — build tool

## License

MIT
