# 007 — web proxy server (CDP transport + REST + SSE)

- **Status:** done
- **Mode:** AFK
- **Estimate:** 1d
- **Depends on:** 006 (transport verdict: GO on SSE+POST)
- **Blocks:** 008, 009

## Goal

Stand up a standalone Node HTTP server (`web/server.mjs`) that is the web port's
backend — the browser-facing equivalent of Electron's `main.js`. It serves the
built renderer and exposes the **entire `window.cdp` surface** over plain HTTP
(POST for commands, SSE for server pushes) plus the `/json` REST the renderer
needs, with no WebSocket on the browser hop and no auth (nginx + Authentik are
handled outside this repo). It owns one active CDP screencast socket, the
notification side-channels, and `settings.json` persistence. After this task the
backend is callable end-to-end by a browser; the renderer shim (t008) and parity
polish (t009) build on it.

## Why now

006 proved SSE+POST carries the screencast. Nothing else in the web port can be
built or verified until a server speaks the renderer's contract. This task is
the backend half; it is independently testable (curl/REST + an SSE capture)
before any renderer change exists.

## Acceptance criteria

- [ ] `node web/server.mjs` boots, binds `0.0.0.0:$PORT` (default 7800), serves
      `dist/index.html` + assets at `/`.
- [ ] `GET /api/events` (SSE) streams `cdp` events (incl. `Page.screencastFrame`),
      `disconnected`, `notification`, `notification-activate`, `native-theme-changed`.
- [ ] `POST /api/invoke` `{method,params}` returns the CDP result; `POST /api/send`
      is fire-and-forget; `POST /api/input` applies a coalesced `InputIntent[]`.
- [ ] REST covers every non-clipboard, non-`local:` `window.cdp` method: list/new/
      close/connect tabs, config get/set/test, sidebar width, ui-state, pins CRUD +
      reorder, theme source get/set, notifications get/mark/clear.
- [ ] Connecting a tab activates it, (re)applies cached metrics + theme emulation,
      starts the screencast, and frames begin arriving on every open SSE client
      (1 upstream → N subscribers).
- [ ] Notification side-channels reconcile against `/json` and push entries over SSE.
- [ ] Settings persist to a configurable `settings.json` path (env override), same
      schema as Electron's.
- [ ] `pnpm test` green incl. the new pure-module tests; `pnpm typecheck` + `pnpm check` clean.

## Test plan

### Layer 1 — Pure logic (TDD)

- [ ] `cdp-endpoints.js` — `/json` URL builders (list/new/close/activate/version);
      Edge PUT for `new`; correct host/port interpolation.
- [ ] `settings-store.js` — pure ui-state get/set mapping with defaults; pins CRUD
      (add dedupes by URL, update by id, remove, reorder); config get/set; the
      legacy `switchBlur`→`switchEffect` and `bookmarks`→`pins` migrations.

### Layer 2 — Manual smoke (CDP/IPC) — self-verified via curl + live host

- [ ] Boot pointed at the remote CDP host → `/api/tabs` returns the live tab list.
- [ ] Open SSE (`curl -N /api/events`), `POST /api/connect` a tab → frames stream.
- [ ] `POST /api/input` a click/keystroke → remote tab reacts.
- [ ] Pins/settings POSTs persist across a server restart.

### Layer 3 — Visual review

n/a — no renderer UI in this task (server only). UI verification is t008/t009.

## Design notes

- **Contracts changed:** none in the renderer. New server-side HTTP contract that
  the t008 shim mirrors onto `window.cdp`.
- **New modules:**
  - `cdp-endpoints.js` (root CJS) — pure `/json` URL builders, shared-by-path with
    any backend; mirrors the URLs `main.js` builds inline.
  - `settings-store.js` (root CJS) — pure settings/pins/ui-state logic over a plain
    object + an injected persist fn; the proxy owns the fs effect.
  - `web/server.mjs` — the HTTP server (effects: CDP WS, SSE fan-out, fs, side-channels).
- **Reused as-is:** `notifications.js`, `theme-emulation.js` (already pure CJS),
  `inject/*.js`.
- **New ADR needed?** yes — draft `0006-web-proxy-architecture.md` (SSE+POST, no-WS
  browser hop, shared-pure-core, capability split). Written in t009 once the whole
  shape is proven.
- **Duplication note:** `cdp-endpoints.js`/`settings-store.js` logic currently also
  lives inline in `main.js`. main.js is intentionally NOT refactored here (AFK,
  no-regression priority); the de-dup is a captured follow-up task.

```ts
// SSE envelope (one stream, all server pushes)
type ServerEvent =
  | { event: "cdp"; method: string; params?: unknown }   // incl. Page.screencastFrame
  | { event: "disconnected" }
  | { event: "notification"; payload: ViewEntry }
  | { event: "notification-activate"; payload: ViewEntry }
  | { event: "native-theme-changed"; payload: { isDark: boolean } } // matchMedia-driven later
```

## Out of scope

- Renderer shim, web entry, capability flags — t008.
- Notification API delivery, theme matchMedia wiring, clipboard, live UI verify — t009.
- Refactoring `main.js` onto the shared core — captured follow-up.
- Auth, TLS, nginx — handled outside the repo.
- Local tabs / extensions / media — Electron-only, never ported.

## Definition of Done

- [ ] Layer 1 tests written + green; Layer 2 curl smoke done against the live host.
- [ ] `pnpm test` / `pnpm typecheck` / `pnpm check` clean.
- [ ] No AI attribution; `t007` in branch + commit.
- [ ] Task closed: status → done, moved to `done/`.

## Notes

Server-only milestone. The spike's `server.mjs` is the seed; this generalizes it
to the full contract and wires the shared pure core.
