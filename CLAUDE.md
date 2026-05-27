# CDP Browser

A lightweight Electron app that connects to a remote Chromium-based browser via Chrome DevTools Protocol (CDP), providing a native-like browsing experience with tab management and input forwarding.

## Where to look

| Topic | Path |
|---|---|
| How we work day-to-day | [docs/conventions/](docs/conventions/) |
| Bite-sized work items (the spine) | [docs/tasks/](docs/tasks/) |
| Decisions we've made and why | [docs/adr/](docs/adr/) |
| Risks, ideas, learnings | [docs/memories/](docs/memories/) |
| Domain glossary | [CONTEXT.md](CONTEXT.md) |
| Dev skills (slash commands) | [.claude/skills/](.claude/skills/) |

## Working principles (the short version)

1. **Convention before code.** `docs/conventions/` is written first; if a convention is missing, write it before the code that needs it.
2. **Product, not software.** Daily-driver feel over technical correctness — pixel-perfect, no jiggling, never-stuck. The bar is "I'd want to use this." See [product.md](docs/conventions/product.md).
3. **Atomic delivery.** Each task is one in-repo `docs/tasks/NNN-*.md` spec sized to one session; it ships and closes (moved to `done/`) in the same commit, with the `tNNN` ID in branch + commit. See [dev-lifecycle.md](docs/conventions/dev-lifecycle.md). GitHub Issues is external bug intake only.
4. **Research, don't assume.** Verify libraries/APIs against current docs (Context7) before adopting.
5. **Test-first for pure logic.** Strict TDD for `src/lib/` + `notifications.js`; manual smoke + HITL for CDP/IPC glue; mock-first + visual review for UI. [tdd.md](docs/conventions/tdd.md).
6. **SOLID, atomic, fresh-not-patched.** Each change does one thing; rewrite scar tissue instead of layering conditionals. [code-quality.md](docs/conventions/code-quality.md).
7. **Claude-Code-first.** Predictable patterns, strong types, **kebab-case for all filenames** (incl. components). [agentic-coding.md](docs/conventions/agentic-coding.md).
8. **shadcn-first frontend.** Vite + React + Tailwind + shadcn (radix-nova / HugeIcons) + Zustand + a hotkey-registry/⌘K-palette/`?`-overlay. Four-state coverage, instant UI, auto-reconnect. No router/GraphQL/i18n. [frontend.md](docs/conventions/frontend.md), [ux.md](docs/conventions/ux.md).
9. **Docs stay alive.** Same-commit doc updates; ADRs append-only; `CONTEXT.md` is the glossary; cap docs ~400 lines. [docs-discipline.md](docs/conventions/docs-discipline.md).
10. **OSS-ready, no AI attribution.** Docs/code read for an unknown operator; never attribute work to AI. [git.md](docs/conventions/git.md).

## Architecture

```
[CDP Browser App] --WebSocket--> [CDP Host :9222] ---> [Remote Browser]
```

- **Window** (`main.js`): A `BaseWindow` with a single full-window **chrome view** (the React renderer). The chrome view draws everything — sidebar, toolbar, the CDP screencast canvas, the local-tab `<webview>`s, and all overlays — so all renderer IPC goes through `chromeView.webContents` (`chromeSend`). See `docs/adr/0005-local-tabs-base-window.md`.
- **Main process** (`main.js`): Manages CDP HTTP API calls and WebSocket connections, plus the `persist:local` session, permissions, extension loading, and the extension action-popup popover. Local tabs render in the renderer DOM (not native views). All WS connections run in Node.js (not renderer) to avoid browser sandbox restrictions.
- **Preload** (`preload.js`): IPC bridge between main and renderer via `contextBridge` — exposes `window.cdp` and `window.local`.
- **Renderer** (`src/`): React + Tailwind + shadcn/ui app. Layered on ten domain modules in `src/lib/` — Remote Page (single live connection, event demux), Tabs (stable ordering), Viewport Transform (letterbox math), Adaptive Viewport (device-metrics state machine), Notifications View (presentation grouping), Key Routing (macOS OS-reserved combo predicate), Pins (live-tab link resolution), Local Tabs (pinned-first ordering + persistence split), Closed Tabs (unified close-ordered reopen stack across CDP + local), and Active Order (MRU activation history across kinds). Local tabs render as in-DOM `<webview>`s (`src/components/local-webviews.tsx`), so overlays stack above the live page via z-index. See `docs/adr/0001-single-remote-page.md` for the single-session constraint.

## Key Design Decisions

- **WebSocket in main process**: Renderer cannot connect to arbitrary WS endpoints due to Electron security. All CDP WS connections are managed in main process and events are forwarded via IPC.
- **Stable tab ordering**: Tabs are tracked in a `tabOrderRef` array. New tabs append to the end. CDP `/json` endpoint reorders tabs by activity — we ignore that ordering. Tabs are drag-reorderable.
- **Mouse position mapping**: Screencast frames may not fill the canvas (black bars due to aspect ratio). `toRemoteCoords()` in `src/lib/viewport-transform.ts` (Viewport Transform) calculates the letterbox offset and scale to map mouse coordinates accurately; both the draw path and Input Forwarding use the same function. The frame is also often **downscaled** from the remote layout viewport (the screencast is capped at the local canvas size, so a larger remote window arrives smaller), so the map scales frame-px → remote DIP using the frame metadata's `deviceWidth`/`deviceHeight` (CDP input wants DIP, not frame-buffer px — the same approach DevTools' screencast uses). `devicePixelRatio` cancels out of the math, so it's never the source of an offset; a wrong click position means a frame/device size mismatch. Without metadata it assumes 1:1 (correct whenever the frame isn't downscaled).
- **Tab activation**: Switching tabs calls `/json/activate/{id}` first, then reconnects the screencast WS. Edge 148 (Chromium 148) allows multiple concurrent CDP clients per target, so read-only side-channel sockets can stay attached to background tabs without disrupting the active screencast session. See `docs/adr/0003-notifications-side-channel.md`.
- **Edge compatibility**: Edge requires `PUT` method for `/json/new` (Chrome accepts `GET`).
- **Adaptive Viewport**: An optional mode that eliminates letterbox bars by resizing the remote page to match the canvas via `Emulation.setDeviceMetricsOverride`. The main process caches the last override and re-applies it before `Page.startScreencast` on every (re)connect. See `docs/adr/0002-adaptive-viewport.md`.
- **Packaging allowlist**: `build.files` in `package.json` is an explicit allowlist, not a denylist. Any new file `main.js` requires/reads at runtime (e.g. `notifications.js`, anything under `inject/`) must be added there, or it gets stripped from the asar and the packaged app throws `Cannot find module` on launch. Renderer code is safe — it's bundled into `dist/` by Vite.
- **Settings persistence**: Host, port, theme, pins, sidebar width, sidebar-collapsed state, pinned-open state, `adaptiveViewport`, `forceOnClient`, `switchEffect`, `notificationsEnabled`, and `syncTheme` are stored in `userData/settings.json`. Saving a new CDP address immediately reconnects to the first available tab. Legacy `switchBlur` boolean is migrated to `switchEffect`, and legacy `bookmarks` to `pins`, on first load.
- **Pins (live-tab holders)**: A pin holds a remote tab (`targetId`), hidden from the Tabs list while linked. Click activates the linked tab or opens+links a fresh one; cmd/middle-click opens an unlinked throwaway tab. Created from a live tab only (toolbar star, right-click tab → Pin, or drag a tab into the Pinned section). A linked pin mirrors its tab's live title/favicon (restoring the saved title when the tab closes); the active pin shows an Arc-style URL-drift cue (a `/` separator and a favicon "Back to Pinned URL" button) when its tab navigates off the saved URL. Closing a pin's tab reverts it to unlinked; un-pinning (confirm dialog) returns the tab to the Tabs list. Cmd+1..9 indexes all pins then visible tabs; Ctrl+Tab cycles open pins + tabs. Link resolution is pure (`src/lib/pins.ts`); persistence/effects live in main + `app.tsx`. See `docs/adr/0004-pin-live-tab-model.md`.
- **Unread badges by origin**: Sidebar unread counts are grouped by URL origin (`unreadByOrigin` in `app.tsx`), so every tab/pin of an app (all Teams, all Outlook) shares one count whether or not it captured the notification, and a dormant pin still badges by its saved URL's origin.
- **Local tabs**: Real local web pages rendered as in-DOM Electron `<webview>`s on a shared `persist:local` session (`src/components/local-webviews.tsx`) — full device access (OS notifications, speaker/mic, camera, screen-share) that CDP screencast tabs can't have. Because a `<webview>` is an in-page OOPIF, React overlays (dialogs, menus, tooltips, the settings sheet) stack **above the live page via CSS z-index** — no native z-order, no freeze. `activeKind: 'cdp' | 'local'` chooses the surface and routes the toolbar/nav hotkeys (`RemotePage` vs the active webview's methods). The renderer holds `LocalTab` metadata and maps webview DOM events to it; only the active webview is shown (others `display:none`, kept alive in the background). All open local tabs persist + restore on launch; pinned ones (a `pinned` flag, distinct from CDP PINNED pins) sort atop the LOCAL TABS section. Unpacked MV3 extensions load into the local session only (`localExtensionPaths`) and their content scripts inject into webview guests; the toolbar shows a Chrome-like action icon per extension (opens its popup in a popover), and popup/options also open as a local tab via the `chrome-extension://` URL. Permissions auto-granted behind the `autoGrantLocalMedia` setting (a `media` request triggers `askForMediaAccess`); packaging ships mic/cam/audio-capture Info.plist keys + entitlements (`build/entitlements.mac.plist`, hardened runtime). See `docs/adr/0005-local-tabs-base-window.md`.
- **Web build (no Electron)**: The same renderer runs as a plain web app via `web/server.mjs` — a Node HTTP proxy that serves the built `dist/` and exposes the whole `window.cdp` surface over **SSE** (`GET /api/events`, server→browser pushes incl. screencast frames) + **POST** (`/api/invoke`, `/api/send`, `/api/cdp-batch`, and REST for tabs/config/ui-state/pins/notifications). No WebSocket on the browser hop (the deploy env blocks it; nginx + Authentik run in front, outside this repo); the proxy→CDP hop is still WS. The renderer installs a web `window.cdp` (`src/lib/cdp-web-transport.ts`) when no preload exists, satisfying the same `CdpBridge` contract; input is coalesced into one POST/frame (`src/lib/input-coalesce.ts`), the proxy acks frames itself, and theme follows `matchMedia`. A `window.webCaps` flag hides Electron-only surfaces (local tabs, extensions); `window.local` is a no-op stub. Pure shared logic lives in root CJS modules `cdp-endpoints.js` (`/json` URL builders) + `settings-store.js` (settings/pins/ui-state). Run `pnpm web`. See `docs/adr/0006-web-proxy-sse-transport.md`. (Note: `main.js` is not yet refactored onto the shared core — a tracked follow-up.) The web build is an installable **PWA** (`public/manifest.webmanifest` with `APP_TITLE`-injected name + `public/sw.js`), has a web-only **push-notification** toggle (`webPush` ui-state gating the Notification API), and lowers input latency with a **streaming input channel** — one long-lived `POST /api/input-stream` (fetch `ReadableStream` body over HTTP/2, NDJSON frames reassembled by `line-splitter.js`) that a probe/`stream-ack` confirms before use and that falls back to `/api/cdp-batch` if a proxy buffers it (still no WebSocket). Streaming needs `proxy_request_buffering off` upstream to activate; when it can't (the default behind nginx/Authentik), mouse input is **event-driven** so it doesn't flood the fallback: a **hover gate** (`createHoverGate`) holds buttons-up moves and emits one resting position only when the cursor stops (drag moves bypass it and track live; clicks carry their own coords), and the `/api/cdp-batch` fallback is **single-flight with move-collapsing** (`createSingleFlight` — one POST in flight, consecutive `mouseMoved` collapse to the latest) so the rate auto-adapts to link RTT instead of backing up fire-and-forget POSTs and starving clicks. See `docs/tasks/done/013-*`. An optional **E2E mode** (set `E2E_PASSPHRASE` on the server) seals every `/api` body + SSE frame in AES-256-GCM (`crypto-envelope.js` server / `src/lib/crypto-envelope.ts` browser, PBKDF2 key from a passphrase entered in the browser, salt served via `GET /api/crypto-params`) so content stays opaque to a TLS-intercepting proxy (Zscaler); a verifier handshake rejects a wrong passphrase, and with E2E off everything is plaintext as before. It defeats network content inspection, not endpoint screen capture. See `docs/tasks/done/012-*`.
- **Notifications side-channel**: A per-target read-only CDP socket (no screencast, no input) stays attached to background tabs that match a notification adapter (Teams + Outlook). A `MutationObserver` capture script is injected at document-start and ships toasts through a `__cdpNotify` binding. Pure logic (`notifications.js`) handles dedup, cap, and OS-toast gating; effects (WS, Electron `Notification`, IPC, persistence to `notifications.json`) live in main process. Each adapter scrapes its app's own in-app notification, which both apps render even when their tab is backgrounded. Clicking a notification activates the tab, then deep-opens the conversation: Outlook ships a per-message deep-link (`targetEntity.deepLink`) and calls `RemotePage.navigateSpa` (client-side `pushState`+`popstate`, full-navigation fallback) to open the exact message without a reload; Teams has no conversation URL (verified — the URL stays bare `/v2/`), so a `"chats"` toast's thread id (`targetEntity.id`, `19:…@thread.v2`) drives `RemotePage.openTeamsThread`, which clicks the chat row carrying that id (meeting-start `"calls"` toasts have no thread and stop at activating the tab). See `docs/adr/0003-notifications-side-channel.md`.

## File Structure

```
cdp-browser/
├── main.js              # Electron main process, CDP API + WS management + notification side-channels
├── preload.js           # IPC bridge (contextBridge)
├── notifications.js     # Pure notification logic (dedup, cap, OS-toast gating); tested by notifications.test.ts
├── notifications.test.ts
├── theme-emulation.js   # Pure theme-sync logic (emulatedMediaParams); CommonJS, tested by theme-emulation.test.ts
├── theme-emulation.test.ts
├── cdp-endpoints.js      # Pure /json URL builders (web build + future main.js); tested by cdp-endpoints.test.ts
├── settings-store.js     # Pure settings/pins/ui-state store (web build); tested by settings-store.test.ts
├── line-splitter.js      # Pure NDJSON frame reassembly for the streaming input channel; tested by line-splitter.test.ts
├── web/
│   └── server.mjs        # Web build backend: serves dist/ + SSE/POST proxy + streaming input (no Electron). See ADR-0006
├── public/               # Web static assets copied into dist/ by Vite: manifest.webmanifest, sw.js, icon.svg, icons/
├── index.html           # Vite entry HTML
├── vite.config.ts       # Vite + React + Tailwind config
├── CONTEXT.md           # Domain glossary (Remote Page, Tab, Screencast Frame, …)
├── inject/
│   ├── teams-notify.js  # MutationObserver capture script injected into Teams pages
│   └── outlook-notify.js # MutationObserver capture for OWA NotificationPane; ships ItemID deep-link
├── scripts/
│   └── install-local.sh # Build + install to /Applications (strips quarantine)
├── docs/
│   ├── adr/             # Append-only architecture decision records
│   ├── agents/          # Skill instructions (issue tracker, triage, domain)
│   └── guides/          # How-to guides (e.g. remote CDP over Tailscale)
├── build/               # App icon assets
│   ├── icon.png
│   ├── icon.icns
│   └── icon.svg
└── src/
    ├── main.tsx          # React entry
    ├── app.tsx           # Root component, state management
    ├── index.css         # Tailwind + theme (light/dark)
    ├── hooks/
    │   └── use-remote-page.ts   # Stable Remote Page ref across renders
    ├── lib/              # Domain modules — see src/lib/CLAUDE.md
    │   ├── remote-page.ts     # Remote Page: navigate/input/events
    │   ├── tabs.ts            # Tab reconcile, next/prev, stripTitleBadge
    │   ├── viewport-transform.ts # Letterbox math + coordinate mapping
    │   ├── adaptive-viewport.ts  # Adaptive Viewport: deviceMetrics + reduce state machine
    │   ├── notifications-view.ts # Presentation grouping (groupByConversation) for notification popover
    │   ├── key-routing.ts     # isOsReservedKey — gates Input Forwarding for macOS-reserved combos
    │   ├── pins.ts            # Pin link resolution: resolvePinLink, pinForTarget, dropDeadLinks
    │   ├── local-tabs.ts      # Local tabs: LocalTab shape, sortPinnedFirst, to/fromPersisted
    │   ├── closed-tabs.ts     # Unified close-ordered reopen stack ({kind,url}) across CDP + local
    │   ├── active-order.ts    # MRU activation history across CDP + local: touchActive, dropActive, mostRecent
    │   ├── cdp-web-transport.ts # Web build: installs window.cdp over POST+SSE, no-op window.local, webCaps (no Electron)
    │   ├── input-coalesce.ts  # Web build: command batcher (coalesce/accumulate/flush) + hover gate (emit on stop) + single-flight POST backpressure
    │   └── utils.ts           # cn() utility
    └── components/        # kebab-case files, PascalCase exports
        ├── sidebar.tsx        # Pinned (live-tab holders) + Tabs list, single DnD context (cross-section pin-on-drag), context menus, active highlight, drag-resizable width; unread tab badges
        ├── toolbar.tsx        # Nav buttons, URL bar, status, pin toggle, settings, NotificationBell
        ├── viewport.tsx       # Screencast canvas + input forwarding; ResizeObserver repaints on container resize
        ├── status-bar.tsx     # Bottom status bar for loading/error states (replaces mid-viewport overlay)
        ├── settings-dialog.tsx  # Non-modal right Sheet drawer (showOverlay=false); grouped cards; hybrid mouse-leave + keyboard-commit close; Cmd+, toggles
        ├── notification-bell.tsx # Bell icon + badge + popover; grouped by conversation
        ├── new-tab-dialog.tsx  # URL input + pin quick-launch (reused for CDP and local)
        ├── edit-pin-dialog.tsx # Edit pin title/URL, with "Use current tab URL" when the linked tab has drifted
        ├── local-webviews.tsx  # Local tabs as in-DOM <webview>s; imperative nav API + DOM-event → LocalTab mapping
        └── ui/                # shadcn (radix-nova style, HugeIcons); regenerate via CLI, owned locally (incl. sonner toasts)
```

Styling: shadcn **radix-nova** preset (`bH58`) + **HugeIcons** (`@hugeicons/react`, not lucide) + **Manrope**/**DM Mono** fonts. Animation: **motion** (`motion/react`, formerly framer-motion) for sidebar row enter/exit — dnd-kit owns the drag transform, motion only wraps a presence-only outer node so the two never fight. Toolchain: **pnpm** (Node 24, `node-linker=hoisted`), **Biome** (lint+format), **husky**+**commitlint**+**lint-staged**.

## Testing

```bash
pnpm test               # Vitest (src/lib/ + notifications.test.ts + scripts/cdp-commands/*.test.mjs)
pnpm typecheck          # tsc --noEmit
pnpm check              # Biome lint + format check (matches CI / pre-commit)
pnpm install:local      # Build + install CDP Browser.app to /Applications
```

## Known Limitations

- CDP screencast only works for the **active tab** on the remote browser.
- Screencast frames are **CSS-resolution** (`Page.startScreencast` ignores `deviceScaleFactor`), so on a high-DPI display they're upscaled and look soft. Sharp device-resolution frames are only available via `Page.captureScreenshot`, which is too heavy to stream and color-shifts vs the screencast — see `docs/adr/0002-adaptive-viewport.md`. Not currently fixed.
- Text input goes through `Input.dispatchKeyEvent`. macOS-reserved combos (Cmd+H hide, Cmd+M minimize, Cmd+Q quit, Ctrl+Cmd+F fullscreen, Cmd+` cycle windows) are detected by `isOsReservedKey` in `src/lib/key-routing.ts` and fall through to native macOS handlers rather than being forwarded. Common editing shortcuts (Cmd/Alt + arrows, line/word deletion) are translated to Blink editor commands, but full IME (CJK composition) is not supported.
- No file download/upload support.
- Tab favicons may not load if the remote browser blocks cross-origin favicon requests.

## Troubleshooting

- **"Connecting..." stuck**: Check that the CDP endpoint is reachable. Run `curl http://<host>:<port>/json`.
- **Mouse clicks offset**: Ensure `toRemoteCoords()` in `src/lib/viewport-transform.ts` is receiving the correct canvas rect, frame size, and `device` size (from the frame's `metadata.deviceWidth`/`deviceHeight`). If `device` is omitted or mismatched, clicks compress toward the top-left on a downscaled frame.
- **"Tab not found" on switch**: Tab may have been closed on remote browser. Refresh tab list.
- **New tab fails**: Edge requires PUT method for `/json/new`.

## Agent skills

### Dev lifecycle skills

Project-local slash commands in `.claude/skills/` (thin SKILL.md → unit-tested `scripts/cdp-commands/*.mjs`): `idea`, `learn`, `risk` (capture to `docs/memories/`), `new-task`/`task`/`status` (the `docs/tasks/` lifecycle), `adr` (scaffold `docs/adr/NNNN-*`), `frontend` (conventions checkpoint), `pr-monitor`. Branch naming is enforced by `.claude/hooks/branch-name-check.sh`.

### Issue tracker (external intake only)

Planned work lives in `docs/tasks/` (the spine). GitHub Issues (`duongdev/cdp-browser`) is for **externally-reported bugs** only; a bug picked up gets promoted to a task or fixed directly. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context (`CONTEXT.md` + `docs/adr/` at the repo root). See `docs/agents/domain.md`.
