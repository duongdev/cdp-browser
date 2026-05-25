# ADR-0005: Local tabs as in-DOM `<webview>` on a BaseWindow

- **Status:** Accepted
- **Date:** 2026-05-24

## Context

CDP tabs render a *remote* browser as a JPEG screencast painted on a canvas —
there is no local DOM, so no local audio/mic/camera, no real notifications, no
extensions. The primary new use case (drive a KVM web UI, join meetings with
mic/camera/screen-share, run an enhancement extension) needs a genuinely local
page with full device access, living beside the CDP tabs in the same window.

The first cut rendered each local tab as a native `WebContentsView` sibling on a
`BaseWindow`. That fought Electron at every turn: a native child view always
composites *above* the renderer, so React overlays (settings sheet, ⌘K palette,
dialogs, menus, tooltips) were trapped under the page. Transparent overlapping
`WebContentsView`s are genuinely broken (compounding-paint bugs —
electron/electron#42335, #45104), so the only workaround was to **freeze** the
page (snapshot via `capturePage`, hide the view, show the still image behind the
overlay). That flickered, blanked, and froze live content (a meeting behind a
tooltip). Not acceptable.

## Decision

Render each local tab as an Electron **`<webview>` element inside the renderer
DOM** (chrome view has `webviewTag: true`), one per tab, only the active one
shown. A modern `<webview>` is an **OOPIF** — a shadow-DOM-wrapped `<iframe>`
composited *inside* the page — so React overlays stack **above the live page via
ordinary CSS z-index**, exactly like a modal over an embedded iframe on the web.
No native z-order, no transparency, no freeze; the page keeps playing behind a
blurred/dimmed backdrop.

- The window stays a **`BaseWindow`** with a single full-window **chrome view**
  (the React renderer). It draws the sidebar, toolbar, CDP screencast canvas,
  the local `<webview>`s, and every overlay.
- `activeKind: 'cdp' | 'local'` chooses the surface: CDP shows the canvas; local
  shows the active `<webview>` (others `display:none`, kept alive in the
  background so audio/calls continue). Toolbar + nav hotkeys call the active
  webview's methods (`loadURL`/`goBack`/`goForward`/`reload`) via a ref.
- `LocalWebviews` (`src/components/local-webviews.tsx`) renders the webviews and
  maps their DOM events (`page-title-updated`, `did-navigate`, loading,
  `media-started-playing`, `new-window`) to `LocalTab` state. `src` is
  uncontrolled so in-page navigation doesn't reload from a state round-trip.
- The main process owns only the `persist:local` session, permissions, extension
  loading, pins persistence, and the extension action-popup popover — it no
  longer creates or positions page views.

## Consequences

- Deleted the entire freeze/snapshot path, the z-order/bounds IPC
  (`local:create/close/navigate/render/capture-active`…), and the
  `src/lib/view-layout.ts` resolver. Overlays "just work" as DOM.
- All existing renderer IPC still goes through `chromeView.webContents`
  (`chromeSend`), since the chrome view is the one renderer.
- Local tabs get real OS notifications, speaker/mic, camera, and screen-share.
  Permissions on `persist:local` are auto-granted behind `autoGrantLocalMedia`;
  macOS TCC still applies, so the packaged app ships
  `NSMicrophoneUsageDescription`/`NSCameraUsageDescription`/`NSAudioCaptureUsageDescription`
  + audio-input/camera entitlements under a hardened runtime. A `media`
  permission request triggers `systemPreferences.askForMediaAccess`.
- Unpacked MV3 extensions load into `persist:local`; their content scripts inject
  into webview guests (verified: the GLKVM enhancement extension runs on the
  live KVM page). Electron has no browser-action bar, so the toolbar renders an
  action icon per loaded extension that opens its popup in a small popover
  WebContentsView; options/popup pages can also open as a local tab via the
  `chrome-extension://` URL.
- Two pin concepts coexist: CDP pins (PINNED section, hold a remote `targetId`;
  see ADR-0004) and local pins (a `pinned` flag atop LOCAL TABS). All open local
  tabs persist and restore on launch.
- Trade-off: `<webview>` is officially "not recommended" by Electron (possible
  future deprecation, async event model). Accepted because it is the only
  approach that compositing-wise lets overlays sit over a *live* local page, and
  it removed more complexity than it added.
