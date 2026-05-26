# t006 — web-proxy SSE screencast spike (throwaway)

De-risks the web port's transport: stream a remote tab's screencast from a Node
proxy to a browser over **SSE**, send input back over **POST**, no WebSocket on
the browser hop. Throwaway — not wired into the app. See
`docs/tasks/006-web-proxy-sse-screencast-spike.md`.

## Run

```bash
# 1. point at a live CDP host (LAN / Tailscale), with a page open on it
CDP_HOST=<host> CDP_PORT=9222 PORT=7800 node spike/web-proxy/server.mjs

# 2. open the page
open http://localhost:7800/
```

The HUD shows fps, per-frame paint latency, frame size, POSTs/sec, conn state.
`GET /stats` returns server-side fps + mean frame KB.

## With nginx in front (the real risk)

```bash
nginx -p "$PWD/spike/web-proxy" -c nginx.conf   # listens :8080 -> proxy :7800
open http://localhost:8080/
```

If frames arrive in stalled bursts instead of live, `proxy_buffering off` is
missing or being overridden — that is the finding to record.

## What to record (go/no-go)

In the task's Notes: sustained fps, added latency vs direct, mean frame KB,
input feel, and whether nginx buffering behaved. Verdict: commit to SSE+POST or
rethink.
