# CDP Browser

The domain language for an Electron app that drives a single remote Chromium page over the Chrome DevTools Protocol and renders it like a native browser. These terms name the seams the renderer is built around; use them in code, tests, and docs instead of synonyms.

## Language

**Remote Browser**:
The external Chromium-based instance reachable over CDP at a configured host and port.
_Avoid_: server, host (those name the address, not the browser).

**Tab**:
The local representation of one remote page (a CDP page target). Tabs are ordered and drag-reorderable; the order is owned locally, not by the Remote Browser.
_Avoid_: target, window.

**Active Tab**:
The single Tab currently connected over WebSocket — the only one receiving Screencast Frames and Input Forwarding. CDP permits exactly one at a time.
_Avoid_: current tab, selected tab.

**Pin**:
A persisted shortcut that holds a Tab. A Pin remembers a title and a saved URL, and optionally **links** to one live remote target (`targetId`). Clicking a Pin shows its content — the linked Tab if alive, otherwise a fresh Tab opened on the saved URL and linked. A Pin's linked Tab is hidden from the Tabs list and lives only in the Pinned section; closing it returns the Pin to unlinked, un-pinning returns the Tab to the Tabs list. Link resolution is pure (`src/lib/pins.ts`); persistence and tab effects live in the main process / `app.tsx`. Replaces the earlier read-only "bookmark".
_Avoid_: bookmark, favorite.

**Remote Page**:
The live connection to the Active Tab's page — the thing callers navigate, reload, copy from, and forward input to. Exactly one exists at a time; it owns the WebSocket lifecycle and demuxes CDP events.
_Avoid_: session, webview, connection.

**Screencast Frame**:
A single JPEG frame pushed by the Remote Page. Each frame must be acknowledged before the next arrives.
_Avoid_: image, snapshot.

**Input Forwarding**:
Translating local keyboard, mouse, wheel, and clipboard events into CDP input on the Remote Page. The frontier for making the experience feel like a real browser (IME, paste, drag, file transfer).
_Avoid_: input dispatch, event forwarding.

**Viewport Transform**:
The mapping from canvas pixels to Remote Page DIP coordinates (CSS px), accounting for letterbox offset (black bars when the Screencast Frame's aspect ratio doesn't match the canvas) and frame downscaling (when the remote window is larger than the local canvas, the frame is smaller than the remote layout viewport — CDP input wants DIP, not frame-buffer px). The same transform must drive both drawing and Input Forwarding hit-testing.
_Avoid_: scaling, getPos, coordinate math.

**Adaptive Viewport**:
An optional mode that eliminates letterbox bars by resizing the remote page itself (via `Emulation.setDeviceMetricsOverride`) to match the canvas dimensions, instead of fitting a fixed-aspect frame. Managed by a pure state machine in `src/lib/adaptive-viewport.ts`; effects (apply/clear override) are executed by the main process. The state machine can go **dormant** when a host-side window resize is detected (back-off); the **auto-recover** preference (`forceOnClient`) controls whether the next user interaction re-arms it automatically or the setting must be toggled manually.
_Avoid_: stretch mode, fill mode, device emulation.

**Switch Effect**:
A CSS `filter` (`none`, `blur`, `grayscale`, or `blur + grayscale`) applied to the canvas during a tab switch, eased back to rest when the new tab's first frame arrives. Persisted as `switchEffect` in `settings.json`; replaces the legacy `switchBlur` boolean.
_Avoid_: tab blur, switch blur, transition filter.

**Notification Side-Channel**:
A read-only CDP WebSocket attached to a background tab's target — no screencast, no input — used to capture in-app toasts via an injected capture script and a `__cdpNotify` binding. Operates independently of the active-tab screencast socket; does not need teardown on tab switch. Edge 148 (Chromium 148) allows multiple concurrent clients per target, which makes this possible.
_Avoid_: background session, helper socket, spy socket.

**Notification Adapter**:
Per-site configuration that declares which URL hostname to match and which capture script to inject. Teams and Outlook (OWA) are the current adapters; the structure generalises to other notification-capable sites.
_Avoid_: plugin, connector, integration.

**Notification Capture**:
The act of a `MutationObserver` inside an injected script observing the site's own in-app toast node, extracting text and `targetEntity` from the DOM/React fiber, and shipping the result through the `__cdpNotify` binding. Pure capture — never navigates.
_Avoid_: scraping, hooking, interception.

**Local Tab**:
A locally-rendered web page displayed as an in-DOM Electron `<webview>` element inside the chrome view. Unlike a **Tab** (which renders a remote page as a JPEG screencast), a Local Tab has full device access: real OS notifications, audio, mic, camera, screen-share, and loadable MV3 extensions. The renderer holds `LocalTab` metadata (`{ id, url, title, favicon?, pinned, loading, canGoBack, canGoForward, audible, muted }`); the main process owns the `persist:local` session and extension loading. Local Tabs occupy the LOCAL TABS sidebar section; a `pinned` flag (distinct from CDP Pins) keeps them atop that section and restores them on relaunch. See `docs/adr/0005-local-tabs-base-window.md`.
_Avoid_: native tab, page view, webview tab.

## Relationships

- A **Remote Browser** hosts many **Tabs**; exactly one is the **Active Tab**.
- The **Active Tab** is rendered as the **Remote Page** (the single live connection).
- The **Remote Page** emits **Screencast Frames** and accepts **Input Forwarding**.
- **Viewport Transform** maps canvas coordinates to **Remote Page** coordinates for both drawing **Screencast Frames** and hit-testing **Input Forwarding**.
- **Adaptive Viewport** (when enabled) resizes the **Remote Page** to the canvas so **Screencast Frames** fill it without letterbox bars.
- A **Notification Side-Channel** attaches to a background **Tab**'s target and uses a **Notification Adapter** to run **Notification Capture** — independent of the **Active Tab**'s screencast socket.
- A **Local Tab** renders a real local web page (in-DOM `<webview>`) alongside CDP Tabs — it does not use **Screencast Frames** or **Input Forwarding**; it gets direct device access instead.

## Example dialogue

> **Dev:** "When the user switches **Tabs**, do we keep the old **Remote Page** connected?"
> **Maintainer:** "No — there's only ever one **Remote Page**. Switching the **Active Tab** tears down the old WebSocket and opens a new one. That's why **Screencast Frames** only ever come from one Tab."

## Flagged ambiguities

- "session" was used loosely for both the WebSocket connection and the tab set — resolved: the live connection is the **Remote Page** (`src/lib/remote-page.ts`); the ordered tab set is owned by `src/lib/tabs.ts` (`reconcile`, `nextTab`, `prevTab`). The unified close-ordered reopen stack lives in `src/lib/closed-tabs.ts` (`createClosedStack`).
- "one debugger per tab" — the old CDP constraint no longer holds on Edge 148 (Chromium 148). The **Remote Page** rule governs the rendering/screencast socket only; auxiliary **Notification Side-Channel** sockets are permitted as separate concurrent clients to the same target. See `docs/adr/0003-notifications-side-channel.md`.
