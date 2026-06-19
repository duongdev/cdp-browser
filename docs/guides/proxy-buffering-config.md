# Unlocking the fast input path behind a reverse proxy

The web build runs the same renderer as a PWA behind a reverse proxy (the daily
driver is NPM + Traefik at `portal.dp.dustin.one`). It has two low-latency input paths —
a **WebSocket** transport and a **streaming POST** channel — that both need a
small amount of proxy config to work. Without it, the app **silently falls back**
to a per-flush POST: input still works, just slower, and nothing tells you why.

This guide is the minimal upstream config to unlock both, the observable symptom
of each missing piece, and how to verify the fast path is actually live.

## When you need this

- You reach the web build through nginx, Nginx Proxy Manager (NPM), Authentik, or
  any reverse proxy — i.e. **not** a direct connection.
- Input feels laggy (the cursor trails, clicks feel late) but the app works.
- The latency HUD's transport segment reads **`Batch ⚠`** (see *How to tell*).

If you connect **directly** to `web/server.mjs` — e.g. `tailscale serve` to local
`:7800`, or `localhost` during dev — none of this applies. The fast path is live
from the first frame and the HUD shows `WS` or `Stream`.

```
[ PWA / browser ]  --HTTPS-->  [ reverse proxy ]  -->  [ web/server.mjs :7800 ]  --WS-->  [ CDP host ]
                               nginx / NPM / Authentik
                               (this is what you configure)
```

## The two settings

Both are upstream proxy settings on the `location` that fronts `web/server.mjs`.
Neither touches the app or the server — they only stop the proxy from breaking
the two fast transports.

### 1. `proxy_request_buffering off` — for the streaming input channel

The streaming input channel (`POST /api/input-stream`, t011) is one long-lived
request whose body streams NDJSON input frames. A proxy that **buffers the
request body** accepts the request but never delivers the body upstream, so input
would vanish. To stay safe, the client sends a `probe` frame on open and only
moves real input onto the stream once the server echoes a `stream-ack`. If the
ack never comes (because the proxy is buffering), the client gives up after a
couple of attempts and uses a per-flush POST **forever**.

- **Without it (symptom):** the stream probe is never acked → the channel never
  activates → input rides `/api/cdp-batch` (one request per flush). The HUD shows
  `Batch ⚠`.
- **Fix:** `proxy_request_buffering off;` on the proxy location.

### 2. The three WS upgrade lines — for the WebSocket transport

The WebSocket transport (`/api/ws`, ADR-0007) is the fastest path: one
full-duplex socket carries events, input, and screencast frames. A proxy that
doesn't forward the HTTP/1.1 `Upgrade`/`Connection` headers answers the upgrade
with a plain response instead of `101 Switching Protocols`, and the client
silently falls back to SSE + POST.

- **Without them (symptom):** `/api/ws` never reaches `101 Switching Protocols`
  → WS never opens → events ride SSE and input rides the streaming/POST path. If
  streaming is also blocked (setting 1), you land on `Batch ⚠`.
- **Fix:** the three upgrade lines below.

```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection $http_connection;
```

> Browsers negotiate WS over HTTP/1.1 (HTTP/2 strips `Upgrade` per RFC 7540), so
> an HTTP/2-default proxy still works in practice once these three lines are
> present. See ADR-0007 for the portal end-to-end test.

## Copy-paste config

### nginx — complete `location` block

Drop this into the `server { … }` that fronts the web build. Replace
`127.0.0.1:7800` with wherever `web/server.mjs` listens.

```nginx
location / {
    proxy_pass http://127.0.0.1:7800;

    # WebSocket transport (/api/ws) — without these, WS never upgrades and the
    # client falls back to SSE + POST.
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $http_connection;

    # Streaming input channel (/api/input-stream) — without this, the stream
    # probe is never delivered and input falls back to per-flush POST.
    proxy_request_buffering off;

    # Pass the original host/scheme so server-side URL building stays correct.
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # Long-lived SSE / WS / streaming connections must not be reaped early.
    proxy_read_timeout 3600s;
    proxy_buffering off;
}
```

`proxy_buffering off` (response buffering) keeps SSE frames flowing promptly;
`proxy_request_buffering off` (request buffering, the one that matters for
streaming input) is the line operators most often miss because it is **on** by
default.

### Nginx Proxy Manager — Advanced "Custom Nginx Configuration"

NPM exposes a per-host *Advanced → Custom Nginx Configuration* box that is
injected inside the generated `location`. Paste:

```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection $http_connection;
proxy_request_buffering off;
```

NPM already sets `proxy_pass`, `Host`, and response buffering for you; these four
lines are the only additions the fast paths need. The "Websockets Support"
toggle in NPM covers the three upgrade lines on some versions — add
`proxy_request_buffering off` regardless, since the toggle does not touch request
buffering.

## How to tell which path is live

The app surfaces the active input transport in the **latency HUD** (off by
default, web-only). Turn it on in **Settings → Latency HUD**; a small readout
appears in the bottom status bar:

```
12ms · ±3ms · 40ms · WS
```

The last segment is the active transport:

| Segment    | Meaning                                                    |
|------------|------------------------------------------------------------|
| `WS`       | WebSocket transport — fastest path, both settings working. |
| `Stream`   | Streaming POST channel — `proxy_request_buffering off` is working; WS is not in use (blocked or not selected). |
| `Batch ⚠`  | **Fallback.** Neither fast path activated — input is on per-flush POST. The proxy is almost certainly buffering. This guide is the fix. |

`Batch ⚠` is the honest signal that a proxy setting is missing. The fallback is a
**safe** state — input still works — but it is the slow one, so the HUD flags it
amber and its tooltip points back here.

You can force the fallback state to preview it without standing up a proxy:
**Settings → Input transport → Basic** pins the client to `batch`, and the HUD
shows `Batch ⚠`.

## Verify the fix end to end

After applying the config, reload the proxy (`nginx -s reload`, or save the host
in NPM) and **hard-reload** the PWA (the transport is chosen once per load).

1. **WS:** with the HUD on, the transport segment settles on `WS` within a second
   or two of load. A network trace of `/api/ws` shows `101 Switching Protocols`.
2. **Streaming (if WS is off / on Streaming mode):** the segment reads `Stream`,
   not `Batch ⚠`. `/api/input-stream` stays open (one long request) instead of a
   burst of `/api/cdp-batch` POSTs.
3. **Still `Batch ⚠`?** Walk the table below.

## Troubleshooting

| Symptom | Likely cause | Check |
|---------|--------------|-------|
| HUD shows `Batch ⚠` after the config | Proxy still buffering / not upgrading | Confirm the four lines are on the **right** `location` and the proxy was reloaded |
| `/api/ws` returns `200`/`404`, not `101` | The three upgrade lines are missing or on the wrong host | Add `proxy_http_version 1.1` + the two `proxy_set_header` lines; reload |
| WS works but input still lags | Streaming probe never acked | Add `proxy_request_buffering off`; it is **on** by default and a separate line from `proxy_buffering off` |
| Fast on a direct connection, slow via the proxy | The proxy is the buffering hop | Compare the HUD via `tailscale serve`/`localhost` (fast) vs the portal (fallback) |
| Segment never leaves `—` | The HUD has no metric yet (no pong / no frames) | Not a proxy issue — wait for the first frame, or check the CDP host is reachable |

## Related

- **ADR-0006** — the web proxy SSE/POST transport and the streaming-POST addendum
  (where `proxy_request_buffering off` originates).
- **ADR-0007** — the WebSocket transport and the three upgrade lines.
- **t011 / t013** (`docs/tasks/done/`) — the streaming input channel and the
  POST-fallback backpressure (hover gate + single-flight) that keeps the fallback
  usable.
</content>
</invoke>
