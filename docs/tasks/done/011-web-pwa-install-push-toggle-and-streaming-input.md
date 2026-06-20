# 011 — web PWA install, push toggle, streaming input

- **Status:** done
- **Mode:** AFK
- **Estimate:** 1d
- **Depends on:** 007, 008, 009
- **Blocks:** none

## Goal

Three improvements to the deployed web build: (1) make it installable as a PWA in
Chrome/Edge, (2) add a "Push notifications" setting that gates the browser
Notification-API toasts (with the permission grant), and (3) cut input latency by
replacing the per-flush `POST /api/cdp-batch` with a single long-lived streaming
upload (`fetch` `ReadableStream` body over HTTP/2) — a persistent client→server
channel without WebSocket, pairing with the existing SSE down-channel. The stream
self-detects via a probe/ack and falls back to the per-flush POST if it can't be
established, so there is zero regression where streaming isn't viable.

## Why now

The app is live behind an SSO proxy at the deployment. Per-POST input through the
auth chain felt laggy; PWA install + a real push toggle were requested.

## Acceptance criteria

- [x] Installable PWA: valid `manifest.webmanifest` (name from `APP_TITLE`), 192/512
      + maskable icons, `display: standalone`, a service worker with a fetch handler.
- [x] Service worker never intercepts `/api/*` or non-GET (SSE/stream/POST hit network);
      navigations network-first, hashed assets cache-first.
- [x] "Push notifications" toggle (web only) requests permission on enable, gates the
      Notification-API toast, reflects a denied/blocked permission.
- [x] Streaming input channel: `POST /api/input-stream` reads NDJSON frames off the
      request body → CDP; client streams over HTTP/2 once a probe is acked over SSE,
      else falls back to `/api/cdp-batch`; gives up after 2 failed attempts (no loop).
- [x] `pnpm test` / `pnpm typecheck` / `pnpm check` green.

## Test plan

### Layer 1 — Pure logic (TDD)

- [x] `line-splitter.js` `createLineSplitter` — reassembles NDJSON frames across chunk
      boundaries; drops blank lines.

### Layer 2 — Manual smoke (CDP/IPC)

- [x] Stream a chunked POST to `/api/input-stream` with a probe + command → server emits
      `stream-ack` over SSE and applies the command (verified via curl, local).

### Layer 3 — Visual review (Chrome DevTools MCP, local h1 vs live host)

- [x] App loads; SW `activated`; manifest name "CDP Portal" + 3 icons + standalone.
- [x] Settings → Notifications shows "Push notifications" (web), permission-aware.
- [x] On h1 (no HTTP/2) the stream cleanly falls back after 2 attempts (no error loop);
      input still works via the POST path; remote drives (6 live tabs, screencast, theme).

## Design notes

- **Contracts changed:** `getUiState`/`setUiState` gain `webPush`. New SSE event
  `stream-ack`. New route `POST /api/input-stream` (NDJSON request stream).
- **New modules:** `line-splitter.js` (pure NDJSON reassembly). `public/manifest.webmanifest`,
  `public/sw.js`, `public/icons/*`.
- **New ADR needed?** no — extends ADR-0006 (note appended there).

```
input flush → batcher (rAF coalesce) → inputChannel.send(line)
   stream up?  → enqueue NDJSON frame on the open POST /api/input-stream (HTTP/2)
   else        → POST /api/cdp-batch   (fallback; same payload)
probe frame → server echoes SSE `stream-ack` → client switches to streaming
```

## Deploy notes (the deploy platform + an SSO proxy + a reverse proxy)

- **Streaming activation requires the request body to NOT be buffered** by any proxy
  in front of the container. On the reverse-proxy/nginx layer, for the app location set
  `proxy_request_buffering off;` (and HTTP/2 enabled, which the deployment already
  negotiates). If the SSO proxy buffers the body, the probe never arrives and the
  client stays on the POST fallback — correct + safe, just no speedup. Validate by
  watching for the `stream-ack` round-trip in devtools.
- `APP_TITLE` env sets both the page title and the PWA install name.
- No new env required; `webPush` persists in the server `settings.json`.

## Out of scope

- WebTransport / HTTP/3 path (noted as a future option in the zoom-out).
- Tuning the SSO/reverse proxy buffering itself (operator-owned).

## Definition of Done

- [x] `pnpm test` (167) / `pnpm typecheck` / `pnpm check` green.
- [x] PWA + push toggle + streaming-fallback verified locally via Chrome DevTools MCP.
- [x] No AI attribution; t011 in branch + commit.
- [x] Task closed: status → done, moved to `done/`.

## Notes

Streaming validated server-side over h1 (curl) since browsers only stream request
bodies over HTTP/2 — the browser path activates on the h2 deploy. The probe/ack +
2-attempt cap makes it safe everywhere: it streams where it can, falls back silently
where it can't, and never loops on failure.
