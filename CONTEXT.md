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
A drop-in seam that spans both capture and activation for one notification-capable site. Each entry in the `ADAPTERS` array of `notifications-sidechain.js` carries: `name` (stable identifier), hostname `match` regex, capture `script` (injected at document-start), `iconUrl`, optional `groupKey(url)` hook (URL-derived per-workspace bucketing; defaults to URL origin), and optional `activate` tagged union (`spa-link` | `thread`) that encodes a deep-open intent as semantic ids — never DOM selectors. The renderer's activation registry (`src/lib/notification-activation.ts`) maps the `activate` type to a Remote Page intention (`navigateSpa` or `openTeamsThread`), keyed by the same `name`. Adding an adapter = one config entry in `ADAPTERS` + one capture script + one activation handler in the renderer registry. Teams, Outlook (OWA), and Slack are the current adapters.
_Avoid_: plugin, connector, integration.

**Notification Capture**:
The act of shipping notification payloads into the store. Two modalities exist. **In-page capture**: an injected script ships payloads through the `__cdpNotify` binding — Teams and Outlook use a `MutationObserver` on the site's own in-app toast DOM; Slack has no in-app toast, so its script patches `window.Notification` (the Web Notifications API hijack) and forces `Notification.permission` → `"granted"`. **Content sweep** (Slack only, ADR-0011): the server reads Slack's authoritative server-side unread state via Slack's web API and synthesizes entries. For Slack the sweep is the authoritative store writer; the hijack is demoted to an instant foreground toast that no longer writes store entries. Pure capture — never navigates.
_Avoid_: scraping, hooking, interception.

**Slack Content Sweep**:
The server-side, authoritative Slack capture modality (ADR-0011). The web server polls Slack's web API (`client.counts` for per-channel unread/mention/thread counts + `last_read`; `conversations.history` for message content; `users.info` for name resolution) using credentials extracted from a live tab (the `xoxc-…` token + `d` cookie), synthesizes notification entries keyed by stable Slack message identity (`slack:{groupId}:{channel}:{ts}`) — where `groupId = enterprise_id || teamId` collapses an Enterprise Grid org and its member workspaces to one key (t092) — and owns the persisted Slack store. Parity baseline = counts-driven (DMs, group DMs, channel mentions, thread replies) + honor Slack muted channels + a user **Channel Exclude** list. Follows Slack `last_read` to auto-mark entries read across all clients. Survives native-app routing, tab focus/suppression, tab sleep, tab closure, and server gaps (caught up via a per-channel watermark on the next poll) — the failure class the in-page hijack alone cannot cover.
_Avoid_: scraper, poller, backfill.

**Workspace Registry**:
The server-side persistence (`slack-workspaces.json`) mapping each Slack `teamId` → `{ url, name, enterpriseId, lastSeen }`, populated the first time a workspace tab is seen live (ADR-0011). Persisting `enterpriseId` lets a cold start resolve each workspace's **Grid Group** without live creds. It drives two things: re-extraction targets for stale creds, and the **Parked Tab** keep-alive loop, which ensures exactly one tab per registered workspace exists on the remote browser (recreated via `/json/new` if closed or after a browser restart) so creds self-refresh and the hijack stays armed. Distinct from ADR-0010 **Workspaces** (multi-CDP-host UI), though both stamp entries with a workspace key.
_Avoid_: account list, team store, tenant table.

**Grid Group**:
The logical Slack workspace bucket used by the **Slack Content Sweep** when an Enterprise Grid org is present. `groupId = enterprise_id || teamId` (`core/slack-creds.js`): member workspaces that share an `enterprise_id` are assigned to the same group so their overlapping shared channels collapse to one notification rather than duplicating. A standalone team (no `enterprise_id`) has `groupId === teamId` and is byte-unchanged. The concrete `teamId` is preserved on each entry for activation deep-links and history fetches — the org token cannot read a member-only channel.
_Avoid_: org group, enterprise bucket, team merge.

**Channel Exclude**:
A user-configured per-channel mute for the **Slack Content Sweep**, stored in server ui-state (survives the iPad PWA's localStorage wipe). Each entry is `{ team, channelId, label }` keyed by the stable channel id. Added via a "Mute this channel" action on a notification or the Settings list. Applied on top of Slack's own muted-channel flag (which the sweep already honors). Distinct from a **Pin** or a muted **Local Tab**.
_Avoid_: mute list, blocklist, filter.

**Phone Shell**:
A distinct layout mode for narrow viewports (reactive `matchMedia` width gate — not pointer-coarseness, not a `caps` flag) where the **Inbox** is the root view and the screencast canvas is a destination reached from a notification or the tab list, not home. The wide layout (sidebar + toolbar + canvas) is untouched above the breakpoint.
_Avoid_: mobile mode, responsive layout, compact view.

**Inbox**:
The Phone Shell's root view — the full-screen notification list grouped by conversation (the same `groupByConversation` read model the bell popover renders). Tapping an entry opens the **Conversation Reader**.
_Avoid_: feed, notification center, home screen.

**Conversation Reader**:
A phone-native notification detail view rendered from captured content — never from Screencast Frames. On the phone surface it is the default tap target for a notification; the screencast drill-in remains an explicit "open in browser" escape hatch. Richness varies by adapter capability: Slack renders a real message view from Slack Content Sweep data (`conversations.history` + `slack-render.js`); adapters without a content backend (Teams, Outlook) show a stub detail built from the captured toast text. Reader availability is a per-adapter capability flag checked by tap routing, not a hardcoded Slack branch. The Slack reader includes a text-only composer (`chat.postMessage` through the same sweep creds); rich content (uploads, emoji pickers, threads UI) stays in the real client. Opening the reader marks the entry read **locally only** — it never writes `conversations.mark`, so Slack's own unread state (and the desktop badge) survives as a to-do trail.
_Avoid_: preview, mini-client, mobile Slack.

**Local Tab**:
A locally-rendered web page displayed as an in-DOM Electron `<webview>` element inside the chrome view. Unlike a **Tab** (which renders a remote page as a JPEG screencast), a Local Tab has full device access: real OS notifications, audio, mic, camera, screen-share, and loadable MV3 extensions. The renderer holds `LocalTab` metadata (`{ id, url, title, favicon?, pinned, loading, canGoBack, canGoForward, audible, muted }`); the main process owns the `persist:local` session and extension loading. Local Tabs occupy the LOCAL TABS sidebar section; a `pinned` flag (distinct from CDP Pins) keeps them atop that section and restores them on relaunch. See `docs/adr/0005-local-tabs-base-window.md`.
_Avoid_: native tab, page view, webview tab.

## Relationships

- A **Remote Browser** hosts many **Tabs**; exactly one is the **Active Tab**.
- The **Active Tab** is rendered as the **Remote Page** (the single live connection).
- The **Remote Page** emits **Screencast Frames** and accepts **Input Forwarding**.
- **Viewport Transform** maps canvas coordinates to **Remote Page** coordinates for both drawing **Screencast Frames** and hit-testing **Input Forwarding**.
- **Adaptive Viewport** (when enabled) resizes the **Remote Page** to the canvas so **Screencast Frames** fill it without letterbox bars.
- A **Notification Side-Channel** attaches to a background **Tab**'s target and uses a **Notification Adapter** to run **Notification Capture** — independent of the **Active Tab**'s screencast socket. Clicking the result activates the owning Tab and, if the entry carries an `activate` intent, the activation registry maps it to a **Remote Page** deep-open intention.
- For Slack, the **Slack Content Sweep** is the authoritative **Notification Capture** writer; the in-page hijack provides only an instant foreground toast. The sweep reads creds from a live **Tab**, persists workspaces in the **Workspace Registry**, keeps a **Parked Tab** alive per registered workspace, and respects the **Channel Exclude** list.
- A **Local Tab** renders a real local web page (in-DOM `<webview>`) alongside CDP Tabs — it does not use **Screencast Frames** or **Input Forwarding**; it gets direct device access instead.

## Example dialogue

> **Dev:** "When the user switches **Tabs**, do we keep the old **Remote Page** connected?"
> **Maintainer:** "No — there's only ever one **Remote Page**. Switching the **Active Tab** tears down the old WebSocket and opens a new one. That's why **Screencast Frames** only ever come from one Tab."

## Flagged ambiguities

- "session" was used loosely for both the WebSocket connection and the tab set — resolved: the live connection is the **Remote Page** (`src/lib/remote-page.ts`); the ordered tab set is owned by `src/lib/tabs.ts` (`reconcile`, `nextTab`, `prevTab`). The unified close-ordered reopen stack lives in `src/lib/closed-tabs.ts` (`createClosedStack`).
- "one debugger per tab" — the old CDP constraint no longer holds on Edge 148 (Chromium 148). The **Remote Page** rule governs the rendering/screencast socket only; auxiliary **Notification Side-Channel** sockets are permitted as separate concurrent clients to the same target. See `docs/adr/0003-notifications-side-channel.md`.
