# ADR-0007: Web build adds optional WebSocket transport

- **Status:** Accepted
- **Date:** 2026-05-28

## Context

ADR-0006 ruled out WebSocket on the browser hop on two grounds: (1) the target
deploy chain (nginx + an SSO proxy in front of `web/server.mjs`) blocked WS, and
(2) browsers can't speak CDP WS directly anyway because Chrome/Edge reject
`/json` upgrades carrying an `Origin` header. (2) is unchanged — a server-side
proxy is still required regardless. (1) was the empirical claim, and on
2026-05-28 a probe (`/api/ws-probe`, since removed) showed it was no longer
true once the NPM custom config grew three lines:

```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection $http_connection;
```

End-to-end through the deployment: `101 Switching Protocols` returned, full
bidirectional frames, and 65 s idle with no proxy drop. Browsers automatically
negotiate WS over HTTP/1.1 (HTTP/2 strips Upgrade per RFC 7540), so the
HTTP/2-default proxy doesn't kill it in practice. The SSO proxy's outpost passes
session cookies through to upstream, so a logged-in browser's WS connection
inherits the same auth context as its REST calls.

With the constraint gone, the per-flush TLS/auth/RTT cost of POST became the
dominant input-latency floor on high-RTT proxy chains. The streaming POST
addendum in ADR-0006 (t011) only partly helps — it requires
`proxy_request_buffering off` upstream and a one-RTT probe before becoming
active. WebSocket removes both: one socket, lower overhead, full duplex.

## Decision

The web build gains a real WebSocket transport (`/api/ws` on the server,
`createWsChannel()` in `cdp-web-transport.ts`) that speaks the same
`CdpBridge` contract over a single full-duplex socket. SSE + POST stay as
fallbacks for environments where WS is blocked.

Envelope: `{ t: "send"|"invoke"|"invoke-result"|"event"|"batch"|"ready", id?, method?, params?, event?, data?, result? }`. The envelope is plaintext (routing
metadata only). Under E2E, the inner `data` (event payloads, matching SSE's
seal point) and `result` (invoke responses) fields are sealed via the existing
`crypto-envelope.ts`. Client → server `send`/`invoke`/`batch` envelopes are
sealed whole, since `method` and `params` themselves carry user content.

The picker exposed in settings (`Auto` / `Fastest` / `Streaming` / `Basic`,
2×2 grid, web-only, persisted to `localStorage` under `inputTransport`) gives
users an escape hatch. Default is `Auto`. Mode change takes effect on next
reload — mid-session transport swap was deferred as a follow-up.

When the active mode is `auto` or `ws`, the renderer opens `/api/ws`. If the
socket becomes ready, all CDP events arrive over WS (SSE event handler
short-circuits to avoid double-fire) and all `send`/`invoke`/`batch` traffic
rides WS. If the socket fails to open or drops, SSE + POST/stream paths handle
everything as before — no change in observable behaviour for users on
WS-hostile chains.

## Consequences

- Web input latency floor drops to one socket round-trip instead of one
  TLS/auth round-trip per flush (or one stream probe + ack on the streaming
  path).
- One more transport to maintain. Three input paths (WS, streaming POST,
  per-flush POST) now coexist, all behind the same `CdpBridge` contract — the
  renderer stays transport-agnostic.
- The "no WS on the browser hop" line from ADR-0006 is no longer true under
  the documented proxy config. ADR-0006 is preserved (append-only convention);
  the new condition is recorded here.
- E2E (ADR-0006, t012) still holds: sealed payloads remain opaque to a TLS-
  intercepting proxy; only routing metadata leaks.
- Deployment depends on the operator's nginx setup. The three-line snippet
  above is the prerequisite; without it, WS upgrades 404 from the upstream and
  the client silently falls back. A future picker enhancement could surface
  "WS unavailable" to the user (see Out of scope).

## Alternatives

- **Raw CDP tunnel (browser WS proxies to CDP WS via the server as a dumb
  pipe).** Rejected — server-side dedup, E2E seal, SSO-proxy integration, and
  the REST surface (tabs/pins/push) would all have to move to the client.
  Performance gain over the envelope path is ~single-digit percent (both
  bottleneck on CDP frame production, per ADR-0006).
- **Keep SSE + POST only, optimise the streaming path further.** Rejected —
  even with `proxy_request_buffering off`, the streaming POST still pays a
  fresh request setup on disconnect; WS keep-alive is cheaper and more robust.
- **WebTransport over HTTP/3.** Deferred. ADR-0006's t011 addendum already
  notes HTTP/3-through-SSO-proxy as uncertain; the WS path solves the same
  latency problem with no new infrastructure dependencies.
- **Drop the picker, auto-only.** Rejected — users on hostile proxies need a
  way to force `batch` and skip the WS probe wait. The picker is the safety
  net.
