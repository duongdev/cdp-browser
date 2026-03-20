# CDP Browser

A lightweight Electron app that connects to a remote Chromium-based browser via Chrome DevTools Protocol (CDP), providing a native-like browsing experience with tab management and input forwarding.

## Architecture

```
[CDP Browser App] --WebSocket--> [CDP Host :9222] ---> [Remote Browser]
```

- **Main process** (`main.js`): Manages CDP HTTP API calls and WebSocket connections. All WS connections run in Node.js (not renderer) to avoid browser sandbox restrictions.
- **Preload** (`preload.js`): IPC bridge between main and renderer via `contextBridge`.
- **Renderer** (`src/`): React + Tailwind + shadcn/ui app with tab management, bookmarks, screencast display, and input forwarding.

## Key Design Decisions

- **WebSocket in main process**: Renderer cannot connect to arbitrary WS endpoints due to Electron security. All CDP WS connections are managed in main process and events are forwarded via IPC.
- **Stable tab ordering**: Tabs are tracked in a `tabOrderRef` array. New tabs append to the end. CDP `/json` endpoint reorders tabs by activity — we ignore that ordering. Tabs are drag-reorderable.
- **Mouse position mapping**: Screencast frames may not fill the canvas (black bars due to aspect ratio). `getPos()` calculates the offset and scale to map mouse coordinates accurately.
- **Tab activation**: CDP only allows one active debugger session per tab. Switching tabs calls `/json/activate/{id}` first, then reconnects WS.
- **Edge compatibility**: Edge requires `PUT` method for `/json/new` (Chrome accepts `GET`).
- **Settings persistence**: Host, port, theme, and bookmarks are stored in `userData/settings.json`.

## File Structure

```
cdp-browser/
├── main.js              # Electron main process, CDP API + WS management
├── preload.js           # IPC bridge (contextBridge)
├── index.html           # Vite entry HTML
├── vite.config.ts       # Vite + React + Tailwind config
├── build/               # App icon assets
│   ├── icon.png
│   ├── icon.icns
│   └── icon.svg
└── src/
    ├── main.tsx          # React entry
    ├── App.tsx           # Root component, state management
    ├── index.css         # Tailwind + theme (light/dark)
    ├── lib/utils.ts      # cn() utility
    └── components/
        ├── Sidebar.tsx        # Tab list + bookmarks (pinned), DnD sortable
        ├── Toolbar.tsx        # Nav buttons, URL bar, status, bookmark, settings
        ├── Viewport.tsx       # Screencast canvas + input forwarding
        ├── SettingsDialog.tsx  # Theme + CDP address config
        ├── NewTabDialog.tsx    # URL input + bookmark quick-launch
        ├── AddBookmarkDialog.tsx # Edit title/URL before saving bookmark
        └── ui/                # shadcn components
```

## Known Limitations

- CDP screencast only works for the **active tab** on the remote browser.
- Text input goes through `Input.dispatchKeyEvent` which may not handle IME correctly.
- No right-click context menu support.
- No file download/upload support.
- Tab favicons may not load if the remote browser blocks cross-origin favicon requests.

## Troubleshooting

- **"Connecting..." stuck**: Check that the CDP endpoint is reachable. Run `curl http://<host>:<port>/json`.
- **Mouse clicks offset**: Ensure `getPos()` is calculating black bar offset correctly.
- **"Tab not found" on switch**: Tab may have been closed on remote browser. Refresh tab list.
- **New tab fails**: Edge requires PUT method for `/json/new`.
