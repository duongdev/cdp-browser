# ADR-0006: Web build — SSE + POST proxy, no WebSocket on the browser hop

- **Status:** Accepted
- **Date:** 2026-05-26

## Context

The app should also run as a plain web app — open a URL, drive the remote browser,
no install. The renderer was already transport-agnostic (the `Transport` seam in
`remote-page.ts`, and `window.cdp` as the single bridge), so the question was the
backend and the wire.

Two constraints shaped it:

1. **The target deploy environment blocks WebSocket on the browser-facing hop**
   (corporate proxy / the nginx + Authentik chain the operator runs in front).
   The renderer therefore cannot hold a WS to the backend.
2. The browser cannot speak CDP directly: Chrome/Edge reject a `/json` WS
   handshake that carries an `Origin` header (every browser sends one), and there
   is no `/json` CORS. A server-side proxy is required regardless.

A spike (t006) measured SSE for the screencast against a live Edge 148 host: it
relayed every frame the proxy emitted, and the throughput ceiling was CDP frame
production — the *same* ceiling Electron already lives with — not the transport.
Verdict: SSE + POST is viable.

## Decision

A standalone Node HTTP server (`web/server.mjs`) is the web backend — the
browser-facing equivalent of Electron's `main.js`:

- **Server → browser:** one **SSE** stream (`GET /api/events`) carries every push
  — CDP events (incl. `Page.screencastFrame`), `disconnected`, and notifications.
  Plain chunked HTTP, no `Upgrade` handshake, so it survives proxies that kill WS.
- **Browser → server:** **POST** — `/api/invoke` (awaited result), `/api/send`
  (fire-and-forget), `/api/cdp-batch` (coalesced input + acks), and REST mirroring
  the rest of the `window.cdp` surface (tabs, config, ui-state, pins, notifications).
- **Backend → CDP host:** WebSocket, exactly as Electron — CDP only speaks WS, and
  this hop runs on the trusted LAN/Tailscale, not through the proxy chain.

The renderer installs a **web `window.cdp`** (`cdp-web-transport.ts`) only when no
Electron preload is present, satisfying the same `CdpBridge` contract over POST +
`EventSource`. The rest of the renderer is unchanged.

Three supporting decisions:

- **Frame acks are server-side.** A per-frame ack over HTTP POST would throttle the
  stream and add a round-trip; the proxy acks each `Page.screencastFrame` to CDP
  itself and the web transport drops the renderer's ack.
- **Input is coalesced at the transport** (`input-coalesce.ts`, a generic batcher):
  `mouseMoved` coalesces to the latest, `mouseWheel` accumulates, discrete events
  flush-then-send immediately with a monotonic `seq`. One POST per animation frame
  instead of one per event.
- **Capability split, not a fork.** A `webCaps` object (`{ web, localTabs, extensions }`)
  is absent under Electron and present in the browser. The shared renderer reads it
  to hide Electron-only surfaces (local tabs, extensions, the local settings tab); a
  no-op `window.local` keeps existing callers from crashing.

No auth, TLS, or nginx lives in this repo — the operator runs nginx + Authentik in
front and the app trusts the upstream.

## Consequences

- One codebase, two transports; bug fixes land once. The renderer never learned it
  was on HTTP instead of IPC.
- Web parity covers viewport, input, tabs, pins, notifications (incl. the
  side-channel and the in-app bell), theme sync, and settings. Theme follows
  `prefers-color-scheme` via `matchMedia`, pushed to the remote as emulated media.
- **Lost on web** (Electron-only, capability-gated off): local `<webview>` tabs,
  MV3 extensions, full media/screen-share, native macOS key routing, and true
  background daemon OS toasts. Web toasts use the Notification API — they require
  permission and only fire while the browser is running.
- Screencast inherits CDP's frame-rate/size ceiling (tunable via quality / max
  dimensions); SSE is not the bottleneck.
- **Duplication debt:** `cdp-endpoints.js` / `settings-store.js` re-express logic
  still inline in `main.js`. main.js was left untouched to avoid regressing the
  shipping Electron app; a follow-up task de-dups it onto the shared core.

## Alternatives considered

- **Direct browser → CDP WS:** blocked by the Origin handshake rejection and the
  no-WS environment. Rejected.
- **WebSocket browser ↔ proxy:** the natural transport, but the deploy environment
  blocks it. Rejected — SSE + POST is the constraint-driven choice.
- **Fork the renderer for web:** guarantees drift on every shared fix. Rejected in
  favour of the runtime capability split.
