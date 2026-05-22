# CDP Browser

A lightweight Electron app that connects to a remote Chromium-based browser via Chrome DevTools Protocol (CDP), providing a native-like browsing experience with tab management and input forwarding.

## Architecture

```
[CDP Browser App] --WebSocket--> [CDP Host :9222] ---> [Remote Browser]
```

- **Main process** (`main.js`): Manages CDP HTTP API calls and WebSocket connections. All WS connections run in Node.js (not renderer) to avoid browser sandbox restrictions.
- **Preload** (`preload.js`): IPC bridge between main and renderer via `contextBridge`.
- **Renderer** (`src/`): React + Tailwind + shadcn/ui app. Layered on four domain modules in `src/lib/` — Remote Page (single live connection, event demux), Tabs (stable ordering), Viewport Transform (letterbox math), and Adaptive Viewport (device-metrics state machine). See `docs/adr/0001-single-remote-page.md` for the single-session constraint.

## Key Design Decisions

- **WebSocket in main process**: Renderer cannot connect to arbitrary WS endpoints due to Electron security. All CDP WS connections are managed in main process and events are forwarded via IPC.
- **Stable tab ordering**: Tabs are tracked in a `tabOrderRef` array. New tabs append to the end. CDP `/json` endpoint reorders tabs by activity — we ignore that ordering. Tabs are drag-reorderable.
- **Mouse position mapping**: Screencast frames may not fill the canvas (black bars due to aspect ratio). `toRemoteCoords()` in `src/lib/viewport-transform.ts` (Viewport Transform) calculates the letterbox offset and scale to map mouse coordinates accurately; both the draw path and Input Forwarding use the same function.
- **Tab activation**: CDP only allows one active debugger session per tab. Switching tabs calls `/json/activate/{id}` first, then reconnects WS.
- **Edge compatibility**: Edge requires `PUT` method for `/json/new` (Chrome accepts `GET`).
- **Adaptive Viewport**: An optional mode that eliminates letterbox bars by resizing the remote page to match the canvas via `Emulation.setDeviceMetricsOverride`. The main process caches the last override and re-applies it before `Page.startScreencast` on every (re)connect. See `docs/adr/0002-adaptive-viewport.md`.
- **Settings persistence**: Host, port, theme, bookmarks, sidebar width, sidebar-collapsed state, pinned-open state, `adaptiveViewport`, and `switchBlur` are stored in `userData/settings.json`. Saving a new CDP address immediately reconnects to the first available tab.

## File Structure

```
cdp-browser/
├── main.js              # Electron main process, CDP API + WS management
├── preload.js           # IPC bridge (contextBridge)
├── index.html           # Vite entry HTML
├── vite.config.ts       # Vite + React + Tailwind config
├── CONTEXT.md           # Domain glossary (Remote Page, Tab, Screencast Frame, …)
├── docs/
│   └── adr/             # Append-only architecture decision records
├── build/               # App icon assets
│   ├── icon.png
│   ├── icon.icns
│   └── icon.svg
└── src/
    ├── main.tsx          # React entry
    ├── App.tsx           # Root component, state management
    ├── index.css         # Tailwind + theme (light/dark)
    ├── hooks/
    │   └── useRemotePage.ts   # Stable Remote Page ref across renders
    ├── lib/              # Domain modules — see src/lib/CLAUDE.md
    │   ├── remote-page.ts     # Remote Page: navigate/input/events
    │   ├── tabs.ts            # Tab reconcile, next/prev, closed-tab stack
    │   ├── viewport-transform.ts # Letterbox math + coordinate mapping
    │   ├── adaptive-viewport.ts  # Adaptive Viewport: deviceMetrics + reduce state machine
    │   └── utils.ts           # cn() utility
    └── components/
        ├── Sidebar.tsx        # Tab list + bookmarks (pinned), DnD sortable, drag-resizable width
        ├── Toolbar.tsx        # Nav buttons, URL bar, status, bookmark, settings
        ├── Viewport.tsx       # Screencast canvas + input forwarding; ResizeObserver repaints on container resize
        ├── StatusBar.tsx      # Bottom status bar for loading/error states (replaces mid-viewport overlay)
        ├── SettingsDialog.tsx  # Theme + CDP address config, test-connection button
        ├── NewTabDialog.tsx    # URL input + bookmark quick-launch
        ├── AddBookmarkDialog.tsx # Edit title/URL before saving bookmark
        └── ui/                # shadcn components
```

## Testing

```bash
npm test          # Vitest unit tests (46 tests across src/lib/)
npx tsc --noEmit  # Type check
```

## Known Limitations

- CDP screencast only works for the **active tab** on the remote browser.
- Screencast frames are **CSS-resolution** (`Page.startScreencast` ignores `deviceScaleFactor`), so on a high-DPI display they're upscaled and look soft. Sharp device-resolution frames are only available via `Page.captureScreenshot`, which is too heavy to stream and color-shifts vs the screencast — see `docs/adr/0002-adaptive-viewport.md`. Not currently fixed.
- Text input goes through `Input.dispatchKeyEvent`. Common macOS editing shortcuts (Cmd/Alt + arrows, line/word deletion) are translated to Blink editor commands, but full IME (CJK composition) is not supported.
- No file download/upload support.
- Tab favicons may not load if the remote browser blocks cross-origin favicon requests.

## Troubleshooting

- **"Connecting..." stuck**: Check that the CDP endpoint is reachable. Run `curl http://<host>:<port>/json`.
- **Mouse clicks offset**: Ensure `toRemoteCoords()` in `src/lib/viewport-transform.ts` is receiving the correct canvas rect and frame size.
- **"Tab not found" on switch**: Tab may have been closed on remote browser. Refresh tab list.
- **New tab fails**: Edge requires PUT method for `/json/new`.

## Agent skills

### Issue tracker

Issues live in GitHub Issues (`duongdev/cdp-browser`), managed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context (`CONTEXT.md` + `docs/adr/` at the repo root). See `docs/agents/domain.md`.
