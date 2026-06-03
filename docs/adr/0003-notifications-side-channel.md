# Notifications via read-only side-channel sessions

To surface Teams messages while another tab is in view, the app captures each notification-capable site's **own in-app toast** and re-presents it as a native notification + a toolbar bell. Capture must work when the site is a **background** tab — exactly when the active-tab screencast socket (`activeWs`) is connected elsewhere.

## Multiple CDP clients per target

ADR 0001 (single Remote Page) and ADR 0002's "rejected: one WebSocket per Tab" both rest on the old "one debugger per tab" limit. That limit no longer holds on **Edge 148** (Chromium 148): multiple WebSocket clients can attach to the same `/devtools/page/<id>` target, each a fully functional session (verified — one socket held `Page`+`Runtime` while a second independently ran `Runtime.addBinding` and received `Runtime.bindingCalled`).

So the single-Remote-Page rule is narrowed: it governs the **rendering/screencast** session only. Auxiliary **read-only side-channels** — no screencast, no input — are permitted as separate sockets. They never touch `activeWs` and need no teardown dance on tab switch.

## Design

- **Adapters** identify notification-capable sites by URL host (Teams now; the structure generalises). Each carries an injected capture script.
- **Reconciler** (main process) polls `/json` every 5s (no browser-level connection → no `Target.targetCreated` events). For each matching target without a side-channel it opens one: `Runtime.enable`, `Runtime.addBinding('__cdpNotify')`, `Page.addScriptToEvaluateOnNewDocument` (future loads) **and** an immediate `Runtime.evaluate` (already-loaded document). Vanished targets are dropped. The `isAttached` map is keyed by **target id** — attach to *all* matching tabs (never miss a leader-only toast); dedup happens later.
- **Capture** (`inject/teams-notify.js`) — a `MutationObserver` watches `[data-testid="notification-wrapper"]`. The toast text is the source/title/body; the durable navigation target lives in the React fiber (`memoizedProps.targetEntity = {action, type, id, dataOptions.userContextId}`), not the DOM. The dedup id is the entity's per-message `dataOptions.messageId` namespaced by thread id (see the 2026-05-28 addendum — the `aria-labelledby` suffix it originally used is the *thread* id, not per-message). Each capture is shipped through the `__cdpNotify` binding.
- **Store** — pure logic (dedup by notification id, newest-first, cap 50, OS-toast gating) lives in `notifications.js`, tested by `notifications.test.ts`; main owns effects (WS, Electron `Notification`, persistence to `notifications.json`, IPC). Dedup by **notification id** is cross-tab safe: the same id from two tabs is the same toast mirrored; different accounts produce different ids.
- **OS toast** fires when enabled, *unless* the site's own in-app toast is already visible — i.e. its tab is active **and** the app window is focused. Switch tabs or alt-tab to another app and the OS toast fires. Clicking it (or a bell row) activates the capturing tab via the normal `switchTab`/`connect` path.

## Deferred: deep-conversation open

Teams' real click handler routes through `activateToast(targetEntity)`; the **test** notification is deliberately no-op'd (`id === "testNotification"` → dismiss), so the test path cannot validate navigation. There is no `<a href>` or URL in the toast, and Teams v2 keeps a single SPA URL regardless of conversation. v1 therefore stops at **activate the tab**. Deep-opening the exact conversation from a captured `targetEntity` needs validation against a *real* notification's `id` format and a working deep-link/route — deferred until then.

## Addendum: Outlook adapter + SPA deep-open (2026-05-23)

The second adapter (`outlook`, `inject/outlook-notify.js`) proves the abstraction generalises and adds the deep-open the Teams path lacked. Verified against Edge 148 / OWA:

- **Same capture model.** OWA renders its in-app notification into `div[data-app-section="NotificationPane"]` **even when the tab is `document.hidden`** — so the read-only side-channel scrapes it exactly like Teams, with no permission grant, no `Notification`-API hook, and no reload. (OWA does **not** use the Web Notification API for mail; it was checked and never fires.) Stable anchors: `button[aria-roledescription="Notification"]`, `aria-label="New mail from <sender>"`; subject/body live in hashed Fluent classes (best-effort, aria is the durable part).
- **Dedup id = message ItemID.** OWA exposes a per-message base64 ItemID (`A[AQM][MQ]k…`) in the notification button's React fiber — cross-tab safe. Content-hash (`source|title|body`) is the fallback. OWA has no conversation id in the toast, so `groupByConversation` falls back to subject.
- **Deep-open via SPA navigation.** Unlike Teams, OWA has a per-message route: `<origin>/mail/inbox/id/<encodeURIComponent(ItemID)>`. The adapter ships it as `targetEntity.deepLink`. Clicking a notification activates the tab, then calls `RemotePage.navigateSpa(deepLink)` — `history.pushState` + a synthetic `popstate` (with a full-navigation `location.href` fallback). This drives react-router client-side (verified: OWA issues the message fetch, no document reload), avoiding the flash/state-loss of `Page.navigate`. `navigateSpa` is adapter-agnostic; any future adapter that supplies a `deepLink` gets deep-open for free.

## Addendum: Teams deep-open by chat-row click (2026-05-27)

The deferred Teams deep-open (above) is now implemented — but **not** via a URL. Verified live against Edge 148 / Teams v2:

- **Teams encodes the conversation nowhere navigable.** Clicking a chat opens it, but the URL stays `https://teams.microsoft.com/v2/`, the hash stays empty, and `history.state` is `{windowHistoryIndex:N}`. So `navigateSpa(url)` cannot work — there is no per-conversation route. This is the answer to the question the original deferral was waiting on: the route does not exist.
- **The thread id lives in the DOM.** Chat rows carry `id="title-chat-list-item_<threadId>"` where `<threadId>` is the canonical `19:…@thread.v2` conversation id. A real `"chats"` notification's `targetEntity.id` is exactly that thread id (confirmed against persisted `notifications.json`: e.g. `19:958eb1c9…@thread.v2`).
- **Deep-open replays the click.** `RemotePage.openTeamsThread(threadId)` runs a `Runtime.evaluate` that finds the chat row by that DOM id (fallback: a `title-chat-list-item_` element whose id ends with the thread id), climbs to its `treeitem` ancestor, and `.click()`s it — retry-polling ~2s since a freshly-notified chat takes a beat to bubble to the top of the list. Verified end-to-end against a real notification's thread id (row found + clicked, conversation opened).
- **Scope.** Only `targetEntity.type === "chats"` (1:1, group, and meeting chats — all `19:…@thread.v2`) deep-open. Meeting-start toasts (`type: "calls"`, `action: "mutate"` / `JoinMeetingFromToast`, id = a toast GUID) have no thread to open and stop at activating the tab, as before. The click-replay is Teams-specific by necessity; `navigateSpa` remains the path for any adapter with a real URL route.

## Addendum: Slack adapter + per-workspace groupKey hook (2026-06-03)

The third adapter (`slack`, `inject/slack-notify.js`) validates the abstraction and introduces two new seam features that the earlier adapters didn't need:

- **Web Notifications API hijack, not MutationObserver.** Slack has no in-app toast node to observe. The capture script patches `window.Notification` at document-start (before Slack caches the original ref at load) and forces `Notification.permission` → `"granted"` — the live tab showed `"default"`, which would suppress all notifications. A minimal stub is returned so Slack can read back handlers and call `close()` without errors. Service-worker `push`-handler notifications (`self.registration.showNotification`) are out of scope (a different JS realm, unreachable from the page-injected script — would require a side-channel on the `service_worker` target).
- **`groupKey(url)` adapter hook.** Multiple Slack workspaces each open in their own tab all share the `app.slack.com` origin, so the default per-origin grouping would merge their unread counts. The new optional `groupKey(url)` hook on a Notification Adapter (backed by `slackGroupKey` / `parseSlackContext` in `core/notifications.js`) derives `slack:{teamId}` from the Tab's URL — the URL is the authoritative workspace identity since the tab is one-per-workspace. The renderer's unread aggregator mirrors this derivation via `groupKeyForUrl` in `src/lib/unread-aggregator.ts` so Tab/Pin badge resolution stays consistent with the notification center's stamped key.
- **Unique-per-fire dedup id.** `slack:{team}:{timestamp}:{seq}` — Slack never replays a fired `window.Notification`, so there is no stable cross-tab dedup target; keying on the notification's `tag` (which coalesces per-channel) would wrongly drop distinct messages. Cross-tab dedup is not relevant (each workspace runs in exactly one tab).
- **Best-effort channel deep-link.** A `spa-link` `activate` pointing at `/client/{team}/{channel}` is emitted when a channel id is extractable from `opts.data`/`opts.tag`; absent → Tab-only activation. Slack's exact notification `data` shape is undocumented, so the extractor probes common key names defensively.

Verified live: URL shape `app.slack.com/client/E…/C…`; Enterprise Grid `E` prefix; `Notification.permission` was `"default"` on the live tab.

## Addendum: per-message dedup id (2026-05-28)

The original "the notification id is the `aria-labelledby` suffix" assumption was wrong — and it silently dropped messages. Diagnosed live (Edge 148 / Teams v2): the suffix `cn-normal-notification-main-text-<X>` has `<X>` = the **conversation thread id** (`19:…@thread.v2`), *shared by every message in that chat*, not a per-message id. So `ingest`'s dedup-by-id collapsed all but the **first** message per conversation — exactly why a test notification (fixed suffix `testNotification`, already uniquified with a timestamp) showed but real follow-up chat messages didn't.

Fix: the Teams adapter keys the dedup id on the entity's per-message `dataOptions.messageId`, namespaced by thread id (`<threadId>:<messageId>`). Distinct per message; cross-tab mirrors of the same message still collapse. The thread id stays as `targetEntity.id` for `groupByConversation` grouping. `notifications.js` is unchanged — dedup-by-id was always correct; only the id the adapter produced was wrong. Confirmed against captured traffic: one thread fired three messages with distinct `messageId`s that previously all reduced to the single thread id.
