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

## Addendum (t011): streaming input, PWA, push toggle

- **Streaming input channel.** Per-flush POSTs each re-paid TLS/auth/RTT through the
  proxy chain. Replaced with one long-lived `POST /api/input-stream` whose body is a
  `fetch` `ReadableStream` (`duplex: 'half'`, HTTP/2 only) carrying NDJSON frames —
  a persistent client→server channel, still no WebSocket, pairing with SSE. A `probe`
  frame must be echoed back as a `stream-ack` over SSE before real input rides the
  stream; if it isn't (no HTTP/2, or a proxy buffers the request body) the client
  falls back to `/api/cdp-batch` and gives up after 2 attempts. Needs
  `proxy_request_buffering off` upstream to activate. WebTransport/HTTP-3 was the
  lower-latency ideal but deferred (HTTP/3-through-Authentik uncertainty).
- **PWA** install via `public/manifest.webmanifest` (name injected from `APP_TITLE`)
  + `public/sw.js` (navigations network-first for Authentik redirects, assets
  cache-first, `/api/*` never intercepted).
- **Push toggle** (`webPush` ui-state, web only): opt-in, requests Notification
  permission on enable, gates the Notification-API toast.

## Addendum (t012): optional E2E payload encryption

For a managed, no-admin, **Zscaler**-inspected device (no tunnel egress possible),
HTTPS to the portal is readable by IT — Zscaler forges certs with a trusted root CA
and decrypts TLS. The only defence on the sole inspected channel is app-layer E2E:
when `E2E_PASSPHRASE` is set on the server, every `/api` body + SSE frame is sealed
in **AES-256-GCM** (`base64(iv‖ct‖tag)`) under a **PBKDF2-SHA256** key derived from a
passphrase entered in the browser (held in `sessionStorage`, key non-extractable) and
matched by the server env. Salt + iterations are public, served via `GET /api/crypto-params`
along with a `verifier` (sealed marker) the client decrypts to confirm the passphrase
before connecting. The seal/open seam wraps the transport helpers + SSE dispatch
(serialized to preserve order); with E2E off, payloads are plaintext (no change).
Honest bound: this defeats network **content inspection/DLP logging**, not endpoint
screen/keystroke capture, and doesn't hide metadata. JPEG frames + verifier are
offline-crack oracles → a **strong passphrase is mandatory**. With E2E on, input uses
the sealed-POST path (the streaming channel's probe/async-seal interplay isn't worth it).

## Addendum (t013): event-driven input + backpressure on the POST fallback

When the streaming channel can't activate (the default behind nginx/Authentik without
`proxy_request_buffering off`), input rides the `/api/cdp-batch` fallback. Streaming a
*continuous hover* — one `mouseMoved` per animation frame, ~60/sec — saturated the
browser's ~6-connection-per-host limit through the proxy: POSTs serialized, backed up,
and (being fire-and-forget) could arrive out of order, so the cursor lagged and **clicks
landed seconds late or appeared ignored** because they queued behind a permanent move
backlog. Two changes fix it, on the principle that the remote only needs *meaningful*
mouse events, not the whole path:

- **Hover gate** (`createHoverGate`, `input-coalesce.ts`): a buttons-up move is held and
  emitted only once the cursor goes still (80 ms), so a continuous hover produces one
  command per rest instead of ~60/sec. A press/release/drag cancels the held move (its
  own coordinates supersede it). **Drag** moves (a button is held) bypass the gate and
  track live, so drag-select and drag-n-drop still work. Clicks carry their own
  coordinates, so a click with no preceding resting move still lands correctly.
- **Single-flight fallback** (`createSingleFlight`): at most one `/api/cdp-batch` POST in
  flight; batches pushed meanwhile accumulate and merge on settle — runs of consecutive
  `mouseMoved` collapse to the latest (`collapseMoves`) while clicks/wheel/keys break a
  run and stay ordered. The request rate auto-adapts to link RTT; a rejected POST resolves
  the flight so the queue never wedges. Bounds the drag burst that the gate doesn't touch.

The streaming path is unchanged (a persistent low-latency channel); both changes are on
the transport's command classification + the fallback only.

## Addendum (t014): correct coordinate mapping for downscaled frames

`toRemoteCoords` was mapping canvas pixels directly to CDP input coordinates, which is
only correct when the Screencast Frame is 1:1 with the remote layout viewport. The web
proxy caps `Page.startScreencast` at the local canvas size, so when the remote window is
larger, the frame is **downscaled** and clicks compressed toward the top-left. Fix: pass
the frame metadata's `deviceWidth`/`deviceHeight` as the `device` argument to
`toRemoteCoords` — it scales frame-px → remote DIP so input lands at the right place
regardless of downscale. `devicePixelRatio` cancels out algebraically and is never the
cause of an offset (see `CLAUDE.md` troubleshooting). Surfaced once t013 made input
responsive enough to aim precisely.

## Addendum (t015–t017): iPad PWA port with real Web Push

The web build is the primary client for iPad (iPad Pro, Magic Keyboard, landscape
workstation use). Three tasks completed the port:

- **t015 — Manifest + safe-area**: `public/manifest.webmanifest` gains `"orientation":
  "landscape"` (landscape-locked for iPad workstation use) and `viewport-fit=cover`
  (required for safe-area env vars). `body` uses `100dvh` to fill the full viewport
  height including the Safari URL bar (avoids the keyboard-collapse issue with `h-screen`).
  Safe-area insets are applied per-component rather than globally on `body`: the sidebar
  scroll container uses `pb-[max(0.5rem,env(safe-area-inset-bottom))]` (home indicator
  clearance with minimum padding), and the status bar uses `pb-[env(safe-area-inset-bottom)]`
  (sits flush with the bottom edge). This avoids a black bar at the home indicator that
  global `body` padding introduced. `#root { height: 100% }` ensures full-height layout.

- **t016 — iPad-aware layout**: Sidebar defaults to 180px on viewports ≤1100px (wider on
  desktop). `install-banner.tsx` prompts Safari-tab users to Add to Home Screen (1-week
  dismiss via localStorage). Web Push toggle in `settings-dialog.tsx` is disabled in
  Safari mode with a "Requires installed PWA" hint — Web Push only works in standalone
  display mode (iOS 16.4+).

- **t017 — Real Web Push (VAPID)**: `web/server.mjs` uses the `web-push` library with a
  VAPID key pair (defaults ship in code; override via `VAPID_PUBLIC_KEY` /
  `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` env vars). Subscriptions persist to
  `web-push-subs.json` next to `settings.json`. Every Teams/Outlook notification that
  arrives via the side-channel also pushes via `sendPushToAll` — so lock-screen
  notifications arrive on iPad even when the PWA is backgrounded. `public/sw.js`
  handles the `push` event (`showNotification`) and `notificationclick` (focus existing
  client + `postMessage`, falls back to `openWindow`). `cdp-web-transport.ts` exposes
  `getPushVapidKey`, `subscribePush`, `unsubscribePush` on the `CdpBridge` contract
  (optional; absent under Electron). Subscription persistence is in-memory + file; lost
  on server restart, users must re-enable the toggle.

## Alternatives considered

- **Direct browser → CDP WS:** blocked by the Origin handshake rejection and the
  no-WS environment. Rejected.
- **WebSocket browser ↔ proxy:** the natural transport, but the deploy environment
  blocks it. Rejected — SSE + POST is the constraint-driven choice.
- **Fork the renderer for web:** guarantees drift on every shared fix. Rejected in
  favour of the runtime capability split.
