# 005 — Support local tabs alongside CDP tabs

- **Status:** done
- **Mode:** HITL
- **Estimate:** multi-session (large; folded from a 5-task chain by request)
- **Depends on:** none
- **Blocks:** none

> **As shipped:** the `WebContentsView` plan below was superseded mid-build by
> in-DOM `<webview>` (OOPIF) local tabs, so React overlays stack above the live
> page via CSS z-index. See `docs/adr/0005-local-tabs-base-window.md` for the
> final architecture and why the native-view approach was abandoned. The Goal /
> design sections below describe the original plan, kept for historical context.

## Locked sidebar redesign ("Arc Spaces") — prototyped in `src/prototype/`

- **Pinned**: square favicon-tile grid; columns computed from the (resizable)
  sidebar width. Active tile elevated (ring + soft bg). Unread = top-right circle
  badge on the favicon.
- **CDP TABS / LOCAL TABS**: accordion "folders" (restyled `ui/accordion.tsx`,
  no built-in chevron). Header = a meaningful leading icon (Cloud for CDP, Laptop
  for Local) that **morphs into a rotating caret on hover** + uppercase label +
  count + inline `+`. Subtle primary-tinted gradient at the top of the sidebar.
- **Keep-active on collapse**: collapsing a folder keeps the tab that was active
  *at collapse time* visible beneath the header (captured on collapse, NOT
  updated on later deactivation).
- **Rows**: favicon + title left-aligned; unread badge top-right on the favicon;
  the local-pin indicator sits at the row's RIGHT so every favicon/title aligns.
- **Collapsed rail** (~56px): pinned tiles, then per-group favicons separated by
  the section icon as a faint **marker** (Cloud / Laptop). Active = elevated tile
  + short primary bar on the rail's left edge; unread top-right; pinned-local =
  tiny corner dot. One `+` at the bottom.
- **Unified new-tab dialog**: a single dialog (the rail `+` and Cmd+T open it),
  defaults to the active tab's kind (else CDP). **Tab** flips CDP↔Local; mode is
  shown by the leading icon + accent (sky for CDP, emerald for Local) + chip —
  **no top segment bar**. Arrow keys navigate suggestions while the input keeps
  focus; Enter opens.
- **Constraints**: must stay smooth with many open tabs (scroll regions, no
  layout jiggle), and all transitions jiggle-free.

## Goal

Add **local tabs** — real, locally-rendered web pages — living beside the
existing CDP (screencast) tabs in the same window. A local tab is a native
`WebContentsView` the main process owns; it gets full-browser parity: real
notifications (OS toasts), audio (speaker + mic), camera, screen-share for
meetings, and loadable unpacked extensions. The renderer's window migrates from
`BrowserWindow` to a `BaseWindow` composed of a transparent chrome view (the
React UI) over one-or-more page views (local tabs), z-ordered so overlays render
above the page without hiding/flicker. The sidebar gains a third section: PINNED
(CDP), CDP TABS, LOCAL TABS. Primary use case: open and drive GLKVM (a KVM web
UI) with its enhancement extension, including video meetings.

## Why now

CDP tabs can only show what a *remote* browser renders — no local audio/mic,
no notifications, no extensions, because the content is a JPEG stream. Anything
needing real local device access (meetings, KVM control with mic/speaker,
extension-enhanced pages) is impossible today. Local tabs unlock that while
keeping the CDP workflow intact.

## Acceptance criteria

- [ ] Window is a `BaseWindow`; existing CDP screencast + input forwarding still
      work unchanged (canvas, tabs, pins, notifications, theme sync).
- [ ] Overlays (settings Sheet, ⌘K palette, `?` overlay, dialogs, context menus,
      notification popover, toasts) render **above** an active local page with
      the page still visible behind — no detach/flicker.
- [ ] A local tab can be created from the LOCAL TABS "New tab" button; it renders
      a real web page in the viewport rect, bounds-synced on resize/sidebar-drag.
- [ ] `activeKind: 'cdp' | 'local'` drives the viewport: selecting a local tab
      hides the canvas + shows its `WebContentsView`; selecting a CDP tab hides
      all page views + shows the canvas.
- [ ] Toolbar (URL bar, back/fwd, reload, status) and nav hotkeys (Cmd+R, [, ],
      L) route to the active kind — `RemotePage` for CDP, `webContents` for local.
- [ ] Local tabs share one persistent session (`persist:local`): GLKVM login,
      extension `storage`, and media-permission grants survive restart.
- [ ] Local tabs can be pinned (a `pinned` flag, NOT the CDP PINNED section);
      pinned local tabs stay atop LOCAL TABS and are restored (re-created) on
      launch. Non-pinned local tabs are ephemeral.
- [ ] Sidebar: TABS renamed → CDP TABS; "New tab" button moved below the CDP TABS
      label; LOCAL TABS section added with its own "New tab". Sections:
      PINNED (max-h-⅓), CDP TABS (flex-1), LOCAL TABS (max-h-⅓), each scrollable.
- [ ] DnD: local tabs reorder within LOCAL TABS; local pin via drag-to-top or
      context-menu. No cross-kind drag (CDP↔local). PINNED stays CDP-only.
- [ ] Cmd+T / Cmd+Shift+T: Cmd+T = new CDP tab. Cmd+Shift+T = reopen the
      most-recently-closed tab of **either** kind (unified close-ordered stack),
      reopened in its original kind.
- [ ] Unpacked extensions from `localExtensionPaths` load into `persist:local`
      (content scripts incl. `world:"MAIN"` + `storage` work). A custom toolbar
      trigger opens the extension `action` popup when a local tab is active.
- [ ] Meeting parity on local tabs: mic + camera work (web perm auto-granted per
      setting; macOS TCC prompts fire); screen-share works (source picker, system
      audio, Screen-Recording-permission deep-link when not granted).
- [ ] Native OS toasts fire for local-tab web `Notification`s (no CDP-style
      side-channel/unread badge for local in this task).
- [ ] New settings: `localExtensionPaths`, `autoGrantLocalMedia`,
      `restoreLocalPins`, `localHomepage` — with settings-dialog UI.

## Test plan

### Layer 1 — Pure logic (TDD)

- [ ] `local-tabs` model — create/close/activate reducers, pinned-first ordering,
      ephemeral vs persisted partition of the tab list.
- [ ] unified closed-tab stack — push/pop preserves close order across kinds;
      each entry carries `{ kind, url }`.
- [ ] active-surface resolution — `activeKind` + which view is shown given
      (active tab, overlay-open) state.
- [ ] z-order resolution — pure function: given (activeKind, overlayOpen,
      localTabs), return the ordered view list / which is on top.

### Layer 2 — Manual smoke (CDP/IPC + main process)

- [ ] CDP regression: connect to a Remote Browser, screencast + input + tab
      switch + pins + notifications all still work after BaseWindow migration.
- [ ] Open a local tab to a real site; resize window + drag sidebar → page view
      bounds track the viewport rect exactly.
- [ ] Open settings / ⌘K / a dialog over an active local tab → modal above page,
      page visible behind, input goes to modal; closing restores page on top.
- [ ] GLKVM: log in, reload app → still logged in (persist:local cookie).
- [ ] Load the GLKVM enhancement extension → content scripts active on GLKVM;
      popup trigger opens popup.html.
- [ ] Join a web meeting on a local tab → mic + camera + screen-share work;
      macOS prompts appear; Screen-Recording deep-link shows when denied.
- [ ] Pin a local tab, quit + relaunch → pinned local tab restored atop LOCAL
      TABS; non-pinned local tabs gone.
- [ ] Close a local tab then Cmd+Shift+T → reopens as a local tab; interleave
      with CDP closes to verify close-order.

### Layer 3 — Visual review

- [ ] Screenshots via Chrome MCP against `pnpm dev`.
- [ ] All four states per section: empty, populated, loading, error.
- [ ] 3-section sidebar: PINNED max-h-⅓, CDP TABS flex-1, LOCAL TABS max-h-⅓,
      independent scroll; New-tab buttons placed per spec; local pins atop LOCAL.
- [ ] Settings dialog shows the new local-tab controls.
- [ ] **Prototype the sidebar + settings UI first** (see Notes) before wiring.

## Design notes

- **Contracts changed:**
  - Window: `BrowserWindow` → `BaseWindow` + `contentView.addChildView`. Chrome
    view (React UI, full-window, transparent over viewport rect) + N page views
    (local tabs). Manual z-order (no `setTopBrowserView` in the new API).
  - App state: add `activeKind: 'cdp' | 'local'`; toolbar/hotkey handlers branch
    on it. New `LocalTab` shape: `{ id, url, title, favicon?, pinned, loading,
    canGoBack, canGoForward, audible, muted }` — renderer holds metadata, main
    owns the views keyed by `id`, pushes updates via IPC events.
  - Closed-tab stack: entries become `{ kind: 'cdp' | 'local', url }`.
  - Settings: `+ localExtensionPaths: string[]`, `+ autoGrantLocalMedia: boolean`
    (default true), `+ restoreLocalPins: boolean` (default true),
    `+ localHomepage: string`. Defaults in `loadSettings()`.
- **New modules:**
  - `src/lib/local-tabs.ts` — pure local-tab list logic (ordering, pinned-first,
    create/close/activate, ephemeral/persist split). TDD.
  - `src/lib/closed-tabs.ts` (or extend `tabs.ts`) — unified close-ordered stack.
  - `src/lib/view-layout.ts` — pure z-order/active-surface resolution. TDD.
  - main: a view/z-order/bounds manager owning `WebContentsView`s + `persist:local`
    session + permission handlers + extension loading.
- **New ADR needed?** **Yes** — two:
  - "Local tabs via BaseWindow + WebContentsView" (window composition, z-order,
    why not stay on BrowserWindow).
  - "Local-tab session, permissions & meeting parity" (persist:local, auto-grant,
    macOS TCC/entitlements, screen-share).
- **Packaging:** electron-builder `extendInfo` for `NSMicrophoneUsageDescription`,
  `NSCameraUsageDescription`, `NSAudioCaptureUsageDescription`; entitlements
  `com.apple.security.device.audio-input`, `com.apple.security.device.camera`
  (hardened runtime — signed release pipeline, t003). Any new runtime file added
  to `build.files` allowlist.

```ts
interface LocalTab {
  id: string
  url: string
  title: string
  favicon?: string
  pinned: boolean
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  audible: boolean
  muted: boolean
}

type ActiveKind = "cdp" | "local"
interface ClosedEntry { kind: ActiveKind; url: string }
```

## Out of scope

- Installing extensions on the *remote* CDP browser, or CDP-side script injection
  (`Page.addScriptToEvaluateOnNewDocument`) — local session only.
- CDP-style unread-badge / notification side-channel for local tabs (native OS
  toasts only this task).
- Seeding GLKVM as a default pin / storing any GLKVM credentials (OSS repo).
- File download/upload UI, IME/CJK composition (pre-existing limitations).
- Per-tab audio mute UI is a nice-to-have, not required.

## Definition of Done

- [ ] Layer 1 tests written and green
- [ ] Layer 2 smoke checklist completed with a live Remote Browser
- [ ] Layer 3 screenshots captured and committed
- [ ] `pnpm check` clean (Biome — lint + format)
- [ ] `pnpm typecheck` clean
- [ ] `pnpm test` green
- [ ] `pnpm dev` boots cleanly and the changed surface works end-to-end
- [ ] CLAUDE.md updated for any modified module
- [ ] Both ADRs written
- [ ] No commented-out code, no `console.log` debris, no AI attribution
- [ ] Task closed: status → done, file moved to `docs/tasks/done/`, t005 in commit

## Notes

Folded from a proposed 5-task chain (BaseWindow foundation → local-tab core →
3-section sidebar UI → extensions → meeting parity) into one task by request.
Implementation will still proceed in that dependency order.

**Start with `/prototype` for the sidebar (3-section) + settings UI** before
wiring any main-process plumbing — lock the layout/interaction first.

### Resolved design decisions (from grilling)

- Render local tabs as native `WebContentsView` (not a second canvas) — only path
  to real audio/mic/notifications/extensions.
- Native `loadExtension` (extension code untouched); popup needs a custom trigger;
  JS-injection is the fallback only if loadExtension breaks.
- One `persist:local` partition; auto-grant mic/cam/notifications/screen-share,
  gated by `autoGrantLocalMedia` setting.
- Two distinct pin concepts: CDP pins (PINNED section, hold remote `targetId`) vs
  local pins (a `pinned` flag, atop LOCAL TABS).
- Native window feel via BaseWindow z-order flip (page visible behind modals), not
  a hide-on-overlay hack.
- Full meeting parity incl. screen-share confirmed in scope.
- Extensions apply to local session only — CDP tabs render remotely, so an
  Electron-side extension has no DOM to attach to.

### UI prototype verdict (kept in repo: `prototype.html` + `src/prototype/`)

Question answered: what should the 3-section sidebar + local settings look like.

- **Sidebar → variation B "Carded":** each section is a rounded card
  (`bg-foreground/[0.03]`) with a header row = a kind-accent dot
  (grey/sky/emerald for Pinned/CDP/Local) + uppercase label + inline `+`
  new-tab button. PINNED max-h-⅓, CDP TABS flex-1, LOCAL TABS max-h-⅓, each its
  own scroll region. Local pins sit atop LOCAL TABS with a pin glyph.
- **Settings → fold into the existing settings-dialog as a tabbed drawer.**
  Add a segmented control at the top: **Remote (CDP)** | **Local tabs**.
  - Remote (CDP) pane = the existing cards unchanged: Appearance, Viewport,
    Notifications, Connection.
  - Local tabs pane = two new `Card`s: "Local tabs" (Homepage `Input`, Restore
    pinned local tabs `Switch`, Auto-grant media permissions `Switch`) and
    "Local extensions" (path list with Reload/remove + "Add unpacked extension…").
  - Reuse the existing `Card` + `Switch`/`Input`/`Label`/`Button` components so
    both panes look identical to today's dialog.
- Delete `prototype.html`, `src/prototype/`, `.proto-shots/` when the real UI
  lands.
