# 006 — web proxy SSE screencast spike

- **Status:** done
- **Mode:** HITL
- **Estimate:** 1d
- **Depends on:** none
- **Blocks:** web port (monorepo split, web transport, proxy feature parity)

## Goal

Prove — or kill — the one assumption the whole web port rests on: that a remote
tab's screencast can be streamed from a Node proxy to a browser over **SSE**
(server→client) with input sent back over **POST** (client→server), with no
WebSocket on the browser↔proxy hop, and that it *feels usable* (latency, frame
rate, no stalls). This is a throwaway spike: a single-file proxy + a single
static HTML page, outside the real app, measuring the risky hops. After it we
know whether to commit to the SSE+POST architecture or rethink the transport.

## Why now

The web port plan picked SSE+POST over WebSocket because the target deploy env
(nginx + Authentik) blocks WS on the browser-facing hop. Every later task —
monorepo split, `packages/core` extraction, `cdp-web-transport.ts`, proxy
feature parity — is wasted if SSE can't carry ~20–30fps of base64 JPEG through
the proxy chain at acceptable latency, or if buffering stalls the stream. De-risk
the transport before building anything durable on it.

## Acceptance criteria

Testable bullets, checkable true/false at the end of the spike.

- [ ] A standalone Node proxy connects to a live CDP host (LAN/Tailscale),
      attaches to the active tab, and runs `Page.startScreencast`.
- [ ] Proxy exposes `GET /events` (SSE, `text/event-stream`) that relays each
      screencast frame as a base64 JPEG event; the proxy acks each frame to CDP.
- [ ] A static HTML page (no build step) consumes the SSE stream via
      `EventSource` and paints frames to a `<canvas>` — live remote view visible
      in a browser.
- [ ] `POST /input` accepts a batched `InputIntent[]`; a click and a keystroke
      sent from the page visibly act on the remote tab.
- [ ] Mouse-move/wheel are coalesced client-side (rAF flush) into batched POSTs
      — verified the page does not fire one POST per raw mousemove.
- [ ] Measured + recorded in Notes: end-to-end frame latency, sustained fps,
      mean frame size, input round-trip feel. A clear go/no-go verdict.
- [ ] Verified through an **nginx reverse proxy** in front (the deploy-shape
      hop), with SSE buffering disabled (`proxy_buffering off` +
      `X-Accel-Buffering: no`) — stream does not stall or batch-deliver. (Authentik
      not required for the spike; nginx is the buffering risk.)

## Test plan

Spike code is throwaway and lives outside `src/` — no production tests. The one
piece that will graduate to a real pure module (`input-coalesce`) gets a proper
test in its own task, not here.

### Layer 1 — Pure logic (TDD)

n/a — spike code is throwaway; the coalescing logic is prototyped inline here and
promoted to a tested `src/lib/input-coalesce.ts` in a later task.

### Layer 2 — Manual smoke (CDP/IPC)

Manual verification against a live Remote Browser is the whole point of the spike:

- [ ] Start the proxy pointed at a live CDP host → screencast frames arrive in
      the terminal log (count + size).
- [ ] Open the static page in Chrome → live remote view renders on canvas.
- [ ] Click a link / type in a field on the page → remote tab responds.
- [ ] Drag the mouse across the page → POST count stays bounded (coalesced),
      not one-per-event.
- [ ] Put nginx in front and repeat → stream stays smooth, no multi-second
      buffering stall.

### Layer 3 — Visual review

n/a — spike uses a throwaway static page, not the real renderer UI. No shadcn,
no four-state coverage. (Visual review starts when the web build renders the
actual `packages/renderer` in a later task.)

## Design notes

This is a measurement spike, not a feature. It deliberately reuses **none** of
the real app — no React, no `src/lib/`, no `Transport` seam — so the numbers
reflect the raw transport, not app overhead. It does mirror the eventual contract
shapes so findings transfer.

- **Contracts changed:** none (throwaway code, no production contract touched).
- **New modules:** none promoted to production this task. Spike artifacts only:
  - `spike/web-proxy/server.mjs` — single-file Node proxy (CDP WS in, SSE+POST out).
  - `spike/web-proxy/index.html` — static page: `EventSource` → canvas, coalesced input.
  - `spike/web-proxy/nginx.conf` — minimal reverse-proxy config exercising the SSE buffering settings.
- **New ADR needed?** no for the spike itself. A later task writes the
  web-proxy architecture ADR once the spike's verdict is in.

Shape the spike mirrors (so it transfers to `cdp-web-transport.ts` later):

```ts
// server→client over SSE (one event stream carries all server pushes)
type ServerEvent =
  | { event: "frame"; data: string /* base64 JPEG, no data: prefix */; sessionId: number }
  | { event: "cdp"; method: string; params?: unknown }
  | { event: "disconnected" }

// client→server: discrete events POST immediately + seq; moves/wheel batched
type InputBatch = { seq: number; intents: InputIntent[] } // InputIntent from remote-page.ts
```

Frames are already base64 JPEG strings in the existing screencast path, so SSE
(UTF-8 text) carries them with no binary framing. Use **HTTP/2** at nginx so the
held-open SSE connection does not consume the HTTP/1.1 6-connection-per-origin
budget.

## Out of scope

- React renderer, `Transport` seam, capability object — later tasks.
- Monorepo split / `packages/core` extraction — later task.
- Tabs, pins, settings, notifications over the proxy — later tasks.
- Authentik auth, TLS — nginx alone is enough to surface the buffering risk.
- Reconnect/resume logic, multi-client SSE fan-out — note observations, don't build.
- Adaptive viewport, theme sync — out.

## Definition of Done

A spike is done when the question is answered and written down — not when code
is polished.

- [ ] Layer 2 smoke checklist completed against a live Remote Browser.
- [ ] nginx-in-front check completed (SSE buffering disabled, no stall).
- [ ] Measurements + **go/no-go verdict** recorded in Notes below.
- [ ] If go: the SSE+POST findings (latency, fps, gotchas, nginx settings) are
      captured so the real `apps/web-proxy` / `cdp-web-transport.ts` tasks inherit them.
- [ ] If no-go: the failure mode and the alternative to evaluate are recorded.
- [ ] Spike code lives under `spike/` (not `src/`), clearly throwaway; no
      production contract or behavior changed.
- [ ] No AI attribution anywhere; `tNNN` in branch + commit.

## Notes

Spike scratchpad — measurements, gotchas, verdict go here.

- Target frame budget for "usable": sustained ≥ ~20fps, end-to-end added latency
  over the LAN baseline within a feel-acceptable margin (record the number).
- Watch for: nginx default `proxy_buffering on` collapsing SSE into bursts;
  base64 inflating frame size ~33% vs raw JPEG; EventSource auto-reconnect
  masking a stalled upstream.

### Measurements (2026-05-26, live Edge 148 @ the remote host, server-side via /stats + raw SSE capture)

Source = YouTube video playing (worst-case continuous motion). One SSE client.

| Screencast params      | fps  | mean frame | SSE frames delivered |
|------------------------|------|-----------|----------------------|
| quality 80, 3000×2000  | 4.5  | 280 KB    | 48–53 / 54 broadcast |
| quality 40, 1280×800   | 11.0 | 67 KB     | 96 / 110 broadcast   |

Missing SSE frames = the one frame broadcast before the client subscribed + the
`curl --max-time` boundary frame. **No mid-stream drops** — SSE relayed every
frame the proxy emitted.

**Finding:** SSE is *not* the bottleneck. fps scales inversely with frame cost
(halve quality+resolution → 2.4× the fps), proving the limiter is CDP screencast
frame production/encode + the ack-gated cadence on the host side — the **same
ceiling the existing Electron app hits** (identical `Page.startScreencast`
path). Web transport does not degrade screencast. Frame size is the knob:
`quality`, `maxWidth/maxHeight`, optionally `everyNthFrame`.

**Verdict: GO on SSE + POST.** The risky hop (browser↔proxy server-push without
WebSocket) carries the screencast cleanly. Commit to the architecture.

### Still open (HITL — need a real browser canvas + nginx, not runnable headless here)

- [ ] Visual smoothness / actual perceived latency painting frames to a canvas.
- [ ] Input POST round-trip *feel* (click/type/drag) — endpoint verified (204),
      coalescing logic verified by construction, but not eyes-on.
- [ ] nginx-in-front buffering check (`nginx.conf` ready; nginx not installed on
      the dev box). Must confirm `proxy_buffering off` keeps the stream live
      through Authentik's chain.

### Recommendations carried to the real port tasks

- Adaptive frame budget: tune `quality`/`maxWidth` to hit ~20fps for the actual
  apps (Teams/Outlook scroll, not video) — they produce far fewer frames than a
  playing video, so real-world fps will sit well above these worst-case numbers.
- Consider a quality/size step-down under sustained high motion (later, if needed).
